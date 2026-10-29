import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { transporteDaConversa } from '@/lib/canais/enviar'
import type { EnviarTexto } from '@/lib/atendimento'
import { protegerEnviarTexto } from '@/lib/envio/portao'
import { ehErroJanela, alertarEnvioManual } from '@/lib/janela'
import { gerarRespostaSara } from '@/lib/sara'
import { dividirEmBaloes } from '@/lib/atendimento'
import { processarMensagemSalomao } from '@/lib/salomao'
import { sleep } from '@/lib/pacing'
import { aplicarMemoriaDoTurno } from '@/lib/memoria/servico'

// Faz a IA responder AGORA a última mensagem do lead (continuar de onde parou),
// acionado manualmente pelo atendente na tela do lead.
// ROTEAMENTO (2026-09-04): família MATRICULADA com Salomão ativo é atendida pelo
// SALOMÃO (não pela Sara) — igual ao webhook. A Sara não sabe tratar financeiro/
// PIX de matriculado; usar a Sara aqui gerava respostas vagas ("vou verificar").
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id } = await req.json()
  if (!lead_id) return NextResponse.json({ error: 'lead_id obrigatório' }, { status: 400 })

  const { data: lead } = await supabase
    .from('leads')
    .select('familia:familias(id, telefone, whatsapp_phone_number_id, nome_responsavel, ja_responsavel)')
    .eq('id', lead_id)
    .single<{ familia: { id: string; telefone: string; whatsapp_phone_number_id: string | null; nome_responsavel: string | null; ja_responsavel: boolean } }>()

  if (!lead?.familia?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })
  const fam = lead.familia
  // Portão de envio (src/lib/envio): conta no número e respeita opt-out/ritmo.
  // Canal da conversa resolvido uma vez (src/lib/canais): o portão conta nele e
  // cada mensagem gravada leva o carimbo dele.
  const conversa = await transporteDaConversa({
    telefone: fam.telefone, familiaId: fam.id, leadId: lead_id, phoneId: fam.whatsapp_phone_number_id,
  })
  const enviarTexto: EnviarTexto = protegerEnviarTexto(
    { origem: 'resposta_ia', canal: conversa.canal, leadId: lead_id, familiaId: fam.id },
    conversa.enviar
  )
  enviarTexto.carimbo = conversa.carimbo

  // Blindagem contra o eco fromMe (ver registrarMensagemManual): enquanto ESTE endpoint
  // envia os balões, marca a trava resposta_lock_em para o webhook do eco não confundir a
  // própria fala da Sara/Salomão com "atendente respondeu manualmente" e pausar a IA. O
  // webhook principal já segura essa trava; a resposta manual não segurava — por isso o
  // eco de um balão ainda pausava a Sara quando a resposta vinha pelo botão "responder agora".
  const adminLock = createServerAdminClient()
  await adminLock.from('leads').update({ resposta_lock_em: new Date().toISOString() }).eq('id', lead_id)
  try {

  // ── Família matriculada + Salomão ativo → quem responde é o SALOMÃO ──────────
  const { data: cfg } = await supabase.from('config_ia').select('salomao_ativo').eq('id', 1).maybeSingle()
  if (fam.ja_responsavel === true && cfg?.salomao_ativo === true) {
    const admin = createServerAdminClient()
    // Acionar o Salomão manualmente = devolver o lead ao bot: reativa a IA para
    // que as próximas mensagens da família também sejam atendidas (o lead pode
    // estar pausado por handoff/ADR-005).
    await admin.from('leads').update({ ia_ativa: true, precisa_atendimento_humano: false }).eq('id', lead_id)
    const { data: ultimaIn } = await supabase
      .from('mensagens')
      .select('conteudo')
      .eq('lead_id', lead_id)
      .eq('direcao', 'in')
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    try {
      await processarMensagemSalomao(admin, {
        leadId: lead_id,
        telefone: fam.telefone,
        nomeFamilia: fam.nome_responsavel || 'Família',
        conteudoIn: ultimaIn?.conteudo || '',
        enviarTexto,
      })
      return NextResponse.json({ ok: true, agente: 'salomao' })
    } catch (eSend) {
      if (ehErroJanela(eSend)) {
        const r = await alertarEnvioManual({
          telefone: fam.telefone,
          texto: 'Fora da janela de 24h — responder o responsável matriculado manualmente pelo WhatsApp.',
          leadId: lead_id,
        })
        return NextResponse.json({
          ok: false,
          janela_fechada: true,
          agente: 'salomao',
          aviso: r.criado
            ? 'Fora da janela de 24h. Criei um alerta em "Alertas" para resposta manual.'
            : 'Fora da janela de 24h. Lead inativo — nenhum alerta criado.',
        })
      }
      const msg = eSend instanceof Error ? eSend.message : 'Erro desconhecido'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  // ── Demais leads (captação) → Sara ──────────────────────────────────────────
  try {
    const sara = await gerarRespostaSara(lead_id)
    if (!sara.resposta?.trim()) return NextResponse.json({ error: 'Sara não gerou resposta' }, { status: 500 })

    const baloes = dividirEmBaloes(sara.resposta)
    try {
      for (let i = 0; i < baloes.length; i++) {
        const wid = await enviarTexto(fam.telefone, baloes[i])
        await supabase.from('mensagens').insert({
          lead_id,
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
        const r = await alertarEnvioManual({ telefone: fam.telefone, texto: sara.resposta, leadId: lead_id })
        return NextResponse.json({
          ok: false,
          janela_fechada: true,
          aviso: r.criado
            ? 'Fora da janela de 24h. Criei um alerta em "Alertas" com a mensagem da Sara pronta para envio manual.'
            : 'Fora da janela de 24h. Lead inativo (perdido/arquivado) — nenhum alerta criado.',
        })
      }
      throw eSend
    }

    if (sara.resumo_anotacao && sara.resumo_anotacao.trim()) {
      await supabase.from('anotacoes').insert({ lead_id, conteudo: sara.resumo_anotacao.trim() })
    }
    await aplicarMemoriaDoTurno(createServerAdminClient(), { leadId: lead_id, origem: 'sara', pedidos: sara.memoria_salvar })

    return NextResponse.json({ ok: true, agente: 'sara', resposta: sara.resposta })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  } finally {
    // Libera a trava de resposta, inclusive em qualquer return acima (janela fechada etc.).
    await adminLock.from('leads').update({ resposta_lock_em: null }).eq('id', lead_id)
  }
}
