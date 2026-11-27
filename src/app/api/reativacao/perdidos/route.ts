import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { transporteDaConversa } from '@/lib/canais/enviar'
import type { EnviarTexto } from '@/lib/atendimento'
import { protegerEnviarTexto, EnvioBarradoError } from '@/lib/envio/portao'
import { ehErroJanela } from '@/lib/janela'
import { gerarRespostaSara } from '@/lib/sara'
import { dividirEmBaloes } from '@/lib/atendimento'
import { assinar } from '@/lib/assinatura'
import { sleep } from '@/lib/pacing'

// REATIVAÇÃO DE PERDIDOS (reengajamento com o depoimento da Jessica).
// A Sara redige UMA mensagem ÚNICA por família (usa o histórico/memória de cada
// lead), pedindo licença, lembrando da conversa anterior e compartilhando o Reel.
// Envio proativo pela origem `reengajar` → passa pelo portão anti-ban (src/lib/envio):
// janela de disparo 8h–20h, teto do dia, opt-out e gate de repetição.
//
// SEGURANÇA:
//  - `dry_run` (DEFAULT true): gera as mensagens e devolve SEM enviar nada.
//  - só envia os lead_ids informados (lote controlado, aprovado pelo gestor).
//  - idempotente: pula quem já recebeu um `reengajar` enviado (envio_ledger).
//  - ritmo próprio entre leads (além do intervalo do portão) p/ não enfileirar rajada.
//  - só envia dentro da janela 8h–20h Acre (guarda própria, independe do modo do portão).
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const REEL = 'https://www.instagram.com/reel/DfiEEkShFis/'

const PROMPT_REATIVACAO = `INSTRUÇÃO ESPECIAL — MENSAGEM DE REATIVAÇÃO (reengajar UMA família cuja conversa esfriou há semanas).
Escreva UMA única mensagem curta, calorosa e pessoal para REABRIR a conversa. Regras:
- Comece pedindo licença por reaparecer (ex.: "me perdoa aparecer assim do nada", "desculpa o sumiço").
- Diga que lembrou da conversa anterior desta família (cite o nome da criança SE você souber pelo histórico/ficha; NUNCA invente nome).
- Compartilhe, como algo que você quis mostrar, o depoimento de uma mãe da escola — a Jessica, mãe da Sofia — com este link EXATAMENTE: ${REEL}
- Convide SEM pressão a retomar / conhecer a escola. Deixe claro que, se não for o momento, tudo bem — saída fácil, sem insistência.
- Tom humano, 1ª pessoa, no máximo 4–5 linhas, 1 ou 2 emojis. NÃO cite valores/preço. NÃO ofereça horário específico de visita de forma agressiva.
- Use o que você sabe desta família (histórico/memória/anotações) para personalizar — cada mensagem precisa ser única.
Responda SOMENTE com o texto da mensagem (pode usar quebras de linha), sem aspas ao redor.`

type Item = {
  lead_id: string
  nome: string | null
  crianca: string | null
  mensagem: string | null
  status: 'rascunho' | 'enviado' | 'ja_reengajado' | 'sem_telefone' | 'opt_out' | 'barrado' | 'janela_fechada' | 'erro'
  detalhe?: string
}

function horaAcre(): number {
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Rio_Branco', hour: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date()).find((p) => p.type === 'hour')?.value
  return Number(h ?? 0)
}

export async function POST(req: NextRequest) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const body = await req.json().catch(() => ({} as Record<string, unknown>))
  const dryRun = body?.dry_run !== false // default TRUE (seguro)
  const leadIds = Array.isArray(body?.lead_ids)
    ? [...new Set((body.lead_ids as unknown[]).map(String).filter(Boolean))].slice(0, 15)
    : []
  // Instrução sob medida por lote (ex.: recuperar uma visita perdida, reengajar família
  // de gêmeos). Vazio = usa o texto padrão de reativação com o depoimento.
  const instrucao = typeof body?.instrucao === 'string' && body.instrucao.trim()
    ? body.instrucao.trim()
    : null
  if (!leadIds.length) return NextResponse.json({ error: 'Informe lead_ids (máx. 15 por lote)' }, { status: 400 })

  // Guarda de janela: envio real só 8h–20h Acre (dry-run pode a qualquer hora).
  if (!dryRun) {
    const h = horaAcre()
    if (h < 8 || h >= 20) {
      return NextResponse.json({ error: `Fora da janela de disparo (8h–20h Acre; agora ${h}h). Rode dentro do horário.` }, { status: 409 })
    }
  }

  const db = createServerAdminClient()
  const itens: Item[] = []

  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i]
    try {
      const { data: lead } = await db
        .from('leads')
        .select('id, familia:familias(id, telefone, whatsapp_phone_number_id, nome_responsavel, opt_out_em), crianca:criancas(nome)')
        .eq('id', leadId)
        .single<{ id: string; familia: { id: string; telefone: string | null; whatsapp_phone_number_id: string | null; nome_responsavel: string | null; opt_out_em: string | null } | null; crianca: unknown }>()

      const fam = lead?.familia
      const nome = fam?.nome_responsavel ?? null
      const cRaw = lead?.crianca as { nome?: string | null } | { nome?: string | null }[] | null | undefined
      const crianca = (Array.isArray(cRaw) ? cRaw[0]?.nome : cRaw?.nome) ?? null
      if (!fam?.telefone) { itens.push({ lead_id: leadId, nome, crianca, mensagem: null, status: 'sem_telefone' }); continue }
      if (fam.opt_out_em) { itens.push({ lead_id: leadId, nome, crianca, mensagem: null, status: 'opt_out' }); continue }

      // Idempotência: já houve um reengajar ENVIADO para este lead?
      if (!dryRun) {
        const { data: jaFoi } = await db
          .from('envio_ledger')
          .select('id')
          .eq('lead_id', leadId)
          .eq('origem', 'reengajar')
          .eq('status', 'enviado')
          .limit(1)
        if ((jaFoi?.length ?? 0) > 0) { itens.push({ lead_id: leadId, nome, crianca, mensagem: null, status: 'ja_reengajado' }); continue }
      }

      // A Sara redige a mensagem única (usa histórico/memória do lead + instrução especial).
      const sara = await gerarRespostaSara(leadId, undefined, undefined, instrucao ?? PROMPT_REATIVACAO)
      const texto = (sara.resposta ?? '').trim()
      if (!texto) { itens.push({ lead_id: leadId, nome, crianca, mensagem: null, status: 'erro', detalhe: 'Sara não gerou mensagem' }); continue }

      if (dryRun) {
        itens.push({ lead_id: leadId, nome, crianca, mensagem: texto, status: 'rascunho' })
        continue
      }

      // Envio real pela origem `reengajar` (anti-ban).
      const conversa = await transporteDaConversa({
        telefone: fam.telefone, familiaId: fam.id, leadId, phoneId: fam.whatsapp_phone_number_id,
      })
      const enviarTexto: EnviarTexto = protegerEnviarTexto(
        { origem: 'reengajar', canal: conversa.canal, leadId, familiaId: fam.id },
        conversa.enviar
      )
      enviarTexto.carimbo = conversa.carimbo

      // Reativa a IA para que, se a família responder, a Sara assuma a conversa.
      await db.from('leads').update({ ia_ativa: true, precisa_atendimento_humano: false }).eq('id', leadId)

      try {
        const baloes = dividirEmBaloes(texto)
        for (let b = 0; b < baloes.length; b++) {
          const wid = await enviarTexto(fam.telefone, assinar('Sara', baloes[b]))
          await db.from('mensagens').insert({
            lead_id: leadId,
            direcao: 'out_ia',
            agente: 'sara',
            agente_origem: 'disparo',
            conteudo: baloes[b],
            whatsapp_message_id: wid,
            ...conversa.carimbo,
          })
          if (b < baloes.length - 1) await sleep(900)
        }
        itens.push({ lead_id: leadId, nome, crianca, mensagem: texto, status: 'enviado' })
      } catch (eSend) {
        if (eSend instanceof EnvioBarradoError) {
          itens.push({ lead_id: leadId, nome, crianca, mensagem: texto, status: 'barrado', detalhe: eSend.motivo })
        } else if (ehErroJanela(eSend)) {
          itens.push({ lead_id: leadId, nome, crianca, mensagem: texto, status: 'janela_fechada' })
        } else {
          itens.push({ lead_id: leadId, nome, crianca, mensagem: texto, status: 'erro', detalhe: eSend instanceof Error ? eSend.message : 'erro no envio' })
        }
      }

      // Ritmo próprio entre famílias (além do intervalo do portão): 3–6s.
      if (i < leadIds.length - 1) await sleep(3000 + Math.floor(Math.random() * 3000))
    } catch (e) {
      itens.push({ lead_id: leadId, nome: null, crianca: null, mensagem: null, status: 'erro', detalhe: e instanceof Error ? e.message : 'erro' })
    }
  }

  const enviados = itens.filter((x) => x.status === 'enviado').length
  return NextResponse.json({ dry_run: dryRun, total: itens.length, enviados, itens })
}
