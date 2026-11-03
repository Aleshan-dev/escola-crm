import { createServerAdminClient } from '@/lib/supabase-server'
import { transporteDaConversa } from '@/lib/canais/enviar'
import type { EnviarTexto } from '@/lib/atendimento'
import { protegerEnviarTexto } from '@/lib/envio/portao'
import { ehErroJanela, alertarEnvioManual } from '@/lib/janela'
import { gerarRespostaSara } from '@/lib/sara'
import { dividirEmBaloes } from '@/lib/atendimento'
import { processarMensagemSalomao } from '@/lib/salomao'
import { sleep } from '@/lib/pacing'
import { aplicarMemoriaDoTurno } from '@/lib/memoria/servico'

export type ResultadoAcionar =
  | { ok: true; agente: 'sara' | 'salomao'; resposta?: string }
  | { ok: false; janela_fechada?: true; agente?: 'salomao'; aviso?: string; error?: string }

/**
 * Faz a IA responder AGORA a última mensagem do lead (continuar de onde parou).
 * Núcleo compartilhado pelo botão "responder agora" (/api/sara/responder) e pela
 * rede de segurança que resgata leads mudos (src/lib/resgate.ts). Roda sempre com
 * o client admin — serve tanto a uma rota autenticada quanto a um cron.
 *
 * ROTEAMENTO (2026-09-04): família MATRICULADA com Salomão ativo é atendida pelo
 * SALOMÃO (não pela Sara) — igual ao webhook. Segura a trava resposta_lock_em
 * enquanto envia os balões, para o eco fromMe não confundir a própria fala da IA
 * com "atendente respondeu manualmente" e pausar. Libera a trava sempre no finally.
 */
export async function acionarIAParaLead(leadId: string): Promise<ResultadoAcionar> {
  const supabase = createServerAdminClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('familia:familias(id, telefone, whatsapp_phone_number_id, nome_responsavel, ja_responsavel)')
    .eq('id', leadId)
    .single<{ familia: { id: string; telefone: string; whatsapp_phone_number_id: string | null; nome_responsavel: string | null; ja_responsavel: boolean } }>()

  if (!lead?.familia?.telefone) return { ok: false, error: 'Lead sem telefone' }
  const fam = lead.familia

  // Canal da conversa resolvido uma vez (src/lib/canais): o portão de envio conta
  // nele (opt-out/ritmo) e cada mensagem gravada leva o carimbo dele.
  const conversa = await transporteDaConversa({
    telefone: fam.telefone, familiaId: fam.id, leadId, phoneId: fam.whatsapp_phone_number_id,
  })
  const enviarTexto: EnviarTexto = protegerEnviarTexto(
    { origem: 'resposta_ia', canal: conversa.canal, leadId, familiaId: fam.id },
    conversa.enviar
  )
  enviarTexto.carimbo = conversa.carimbo

  await supabase.from('leads').update({ resposta_lock_em: new Date().toISOString() }).eq('id', leadId)
  try {
    // ── Família matriculada + Salomão ativo → quem responde é o SALOMÃO ──────────
    const { data: cfg } = await supabase.from('config_ia').select('salomao_ativo').eq('id', 1).maybeSingle()
    if (fam.ja_responsavel === true && cfg?.salomao_ativo === true) {
      // Acionar o Salomão = devolver o lead ao bot: reativa a IA para as próximas
      // mensagens também serem atendidas (o lead pode estar pausado por handoff/ADR-005).
      await supabase.from('leads').update({ ia_ativa: true, precisa_atendimento_humano: false }).eq('id', leadId)
      const { data: ultimaIn } = await supabase
        .from('mensagens')
        .select('conteudo')
        .eq('lead_id', leadId)
        .eq('direcao', 'in')
        .order('criado_em', { ascending: false })
        .limit(1)
        .maybeSingle()
      try {
        await processarMensagemSalomao(supabase, {
          leadId,
          telefone: fam.telefone,
          nomeFamilia: fam.nome_responsavel || 'Família',
          conteudoIn: ultimaIn?.conteudo || '',
          enviarTexto,
        })
        return { ok: true, agente: 'salomao' }
      } catch (eSend) {
        if (ehErroJanela(eSend)) {
          const r = await alertarEnvioManual({
            telefone: fam.telefone,
            texto: 'Fora da janela de 24h — responder o responsável matriculado manualmente pelo WhatsApp.',
            leadId,
          })
          return {
            ok: false,
            janela_fechada: true,
            agente: 'salomao',
            aviso: r.criado
              ? 'Fora da janela de 24h. Criei um alerta em "Alertas" para resposta manual.'
              : 'Fora da janela de 24h. Lead inativo — nenhum alerta criado.',
          }
        }
        return { ok: false, error: eSend instanceof Error ? eSend.message : 'Erro desconhecido' }
      }
    }

    // ── Demais leads (captação) → Sara ──────────────────────────────────────────
    try {
      const sara = await gerarRespostaSara(leadId)
      if (!sara.resposta?.trim()) return { ok: false, error: 'Sara não gerou resposta' }

      const baloes = dividirEmBaloes(sara.resposta)
      try {
        for (let i = 0; i < baloes.length; i++) {
          const wid = await enviarTexto(fam.telefone, baloes[i])
          await supabase.from('mensagens').insert({
            lead_id: leadId,
            direcao: 'out_ia',
            agente: 'sara',
            agente_origem: 'conversa',
            conteudo: baloes[i],
            whatsapp_message_id: wid,
            ...conversa.carimbo,
          })
          if (i < baloes.length - 1) await sleep(900)
        }
      } catch (eSend) {
        // Janela de 24h fechada: cria alerta para envio manual com o texto completo.
        if (ehErroJanela(eSend)) {
          const r = await alertarEnvioManual({ telefone: fam.telefone, texto: sara.resposta, leadId })
          return {
            ok: false,
            janela_fechada: true,
            aviso: r.criado
              ? 'Fora da janela de 24h. Criei um alerta em "Alertas" com a mensagem da Sara pronta para envio manual.'
              : 'Fora da janela de 24h. Lead inativo (perdido/arquivado) — nenhum alerta criado.',
          }
        }
        throw eSend
      }

      if (sara.resumo_anotacao && sara.resumo_anotacao.trim()) {
        await supabase.from('anotacoes').insert({ lead_id: leadId, conteudo: sara.resumo_anotacao.trim() })
      }
      await aplicarMemoriaDoTurno(supabase, { leadId, origem: 'sara', pedidos: sara.memoria_salvar })

      return { ok: true, agente: 'sara', resposta: sara.resposta }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Erro desconhecido' }
    }
  } finally {
    // Libera a trava de resposta, inclusive em qualquer return acima (janela fechada etc.).
    await supabase.from('leads').update({ resposta_lock_em: null }).eq('id', leadId)
  }
}
