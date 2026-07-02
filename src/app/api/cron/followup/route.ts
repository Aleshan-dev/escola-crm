import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara } from '@/lib/sara'

// ADR-004: o cron decide QUANDO agir (determinístico); a Sara decide O QUE dizer.

// Horário comercial no fuso da escola: Rio Branco / Acre (UTC-5, sem horário de verão).
const ACRE_SHIFT_MS = -5 * 60 * 60 * 1000
const HORA_MIN = 8
const HORA_MAX = 20

function horaAcre(): number {
  return new Date(Date.now() + ACRE_SHIFT_MS).getUTCHours()
}

type TriggerNome =
  | 'primeiro_contato'
  | 'confirmacao_visita'
  | 'followup_pos_visita'
  | 'recuperacao'
  | 'reengajamento'

type LeadRow = {
  id: string
  coluna_id: string
  familia_id: string
  ultima_interacao_em: string | null
  entrou_coluna_em: string | null
  data_proxima_acao: string | null
  followup_count: number
  ultimo_followup_em: string | null
  followup_status: string
  familia: { telefone: string; nome_responsavel: string } | null
  coluna: {
    nome: string
    ordem: number
    followup_intervalo_horas: number | null
    followup_max: number
  } | null
}

type Resultado = {
  lead: string
  trigger?: TriggerNome
  enviado?: boolean
  erro?: string | null
  skip?: string
}

function triggerPorColuna(nome: string): TriggerNome {
  switch (nome) {
    case 'Capturados':
      return 'primeiro_contato'
    case 'Visita Agendada':
      return 'confirmacao_visita'
    case 'Visita Realizada':
      return 'followup_pos_visita'
    case 'Repescagem':
      return 'recuperacao'
    default:
      return 'reengajamento'
  }
}

function promptPorTrigger(trigger: TriggerNome, nome: string, tentativa: number): string {
  const insistencia =
    tentativa >= 2
      ? ' Esta já é uma tentativa de reforço; seja breve, gentil e sem pressionar.'
      : ''
  switch (trigger) {
    case 'primeiro_contato':
      return `Faça o primeiro contato com ${nome}. A família entrou em contato mas ainda não houve atendimento. Apresente-se como Sara, consultora do Colégio Pequenos Guardiões, demonstre acolhimento cristão e pergunte sobre a criança e o que buscam na escola.${insistencia}`
    case 'confirmacao_visita':
      return `Confirme a visita agendada com ${nome}. Seja calorosa, confirme o endereço e o horário, e diga que a escola espera com alegria.${insistencia}`
    case 'followup_pos_visita':
      return `Faça um follow-up empático após a visita com ${nome}. Pergunte o que acharam da escola, se a criança gostou e se há dúvidas antes de decidir.${insistencia}`
    case 'recuperacao':
      return `Faça uma tentativa gentil de recuperação com ${nome}, que está há dias sem avançar. Reforce o diferencial cristão da escola e pergunte se houve alguma preocupação que possa ser esclarecida.${insistencia}`
    case 'reengajamento':
      return `Reengaje ${nome} de forma leve e acolhedora. A família parou de responder no meio do atendimento. Retome a conversa com empatia, sem pressionar, e ofereça ajuda para o próximo passo.${insistencia}`
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const vercelCron = req.headers.get('x-vercel-cron')
  const autenticado = vercelCron === '1' || (!!cronSecret && authHeader === `Bearer ${cronSecret}`)
  if (!autenticado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const hora = horaAcre()
  if (hora < HORA_MIN || hora >= HORA_MAX) {
    return NextResponse.json({ skipped: `fora_do_horario_comercial (${hora}h Acre)` })
  }

  const supabase = createServerAdminClient()
  const agora = Date.now()

  const { data: leadsRaw, error } = await supabase
    .from('leads')
    .select(
      `id, coluna_id, familia_id, ultima_interacao_em, entrou_coluna_em, data_proxima_acao,
       followup_count, ultimo_followup_em, followup_status,
       familia:familias(telefone, nome_responsavel),
       coluna:colunas(nome, ordem, followup_intervalo_horas, followup_max)`
    )
    .eq('ia_ativa', true)
    .eq('followup_status', 'ativo')
    .eq('arquivado', false)
    .neq('precisa_atendimento_humano', true)

  if (error) {
    console.error('Erro ao buscar leads para follow-up:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const resultados: Resultado[] = []

  for (const lead of (leadsRaw || []) as unknown as LeadRow[]) {
    const tel = lead.familia?.telefone
    const col = lead.coluna
    if (!tel || !col) continue

    const intervaloBase = col.followup_intervalo_horas
    if (intervaloBase == null) continue // etapa sem follow-up (ex.: Matriculados, Perdidos)

    // Esgotou tentativas -> marca e para de tentar
    if (lead.followup_count >= col.followup_max) {
      await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
      resultados.push({ lead: lead.id, skip: 'esgotado' })
      continue
    }

    const ultimaInteracao = lead.ultima_interacao_em ? new Date(lead.ultima_interacao_em).getTime() : 0
    const ultimoFollowup = lead.ultimo_followup_em ? new Date(lead.ultimo_followup_em).getTime() : 0
    const entrouColuna = lead.entrou_coluna_em ? new Date(lead.entrou_coluna_em).getTime() : 0

    // Se o lead respondeu depois do último follow-up, considera reengajado: zera o contador
    let count = lead.followup_count
    if (ultimoFollowup > 0 && ultimaInteracao > ultimoFollowup && count > 0) {
      count = 0
      await supabase.from('leads').update({ followup_count: 0 }).eq('id', lead.id)
    }

    const trigger = triggerPorColuna(col.nome)

    // Caso especial: confirmação de visita = ~1 dia antes da data agendada (não usa backoff)
    if (trigger === 'confirmacao_visita') {
      if (!lead.data_proxima_acao) continue
      const wVisita = new Date(new Date(lead.data_proxima_acao).getTime() + ACRE_SHIFT_MS)
      const wAmanha = new Date(agora + ACRE_SHIFT_MS + 24 * 60 * 60 * 1000)
      const ehAmanha =
        wVisita.getUTCFullYear() === wAmanha.getUTCFullYear() &&
        wVisita.getUTCMonth() === wAmanha.getUTCMonth() &&
        wVisita.getUTCDate() === wAmanha.getUTCDate()
      if (!ehAmanha) continue
      if (ultimoFollowup > agora - 20 * 60 * 60 * 1000) continue // não confirma duas vezes no mesmo dia
    } else {
      // Backoff crescente: o intervalo aumenta a cada tentativa
      const intervaloMs = intervaloBase * (count + 1) * 60 * 60 * 1000
      const referencia = Math.max(ultimaInteracao, ultimoFollowup, entrouColuna)
      if (referencia + intervaloMs > agora) continue // ainda não é hora
    }

    // Sara gera o texto; o envio é responsabilidade determinística do cron
    let enviado = false
    let erro: string | null = null
    let texto = ''
    try {
      const saraResult = await gerarRespostaSara(
        lead.id,
        undefined,
        undefined,
        promptPorTrigger(trigger, lead.familia!.nome_responsavel, count + 1)
      )
      texto = saraResult.resposta
      const sent = await evolutionSendText(tel, texto)
      enviado = true
      await supabase.from('mensagens').insert({
        lead_id: lead.id,
        direcao: 'out_ia',
        conteudo: texto,
        whatsapp_message_id: sent?.key?.id || null,
      })
    } catch (e) {
      erro = e instanceof Error ? e.message : 'erro desconhecido'
      console.error(`Follow-up falhou para lead ${lead.id}:`, erro)
    }

    // Auditoria: registra toda tentativa (enviada ou falha)
    await supabase.from('followup_log').insert({
      lead_id: lead.id,
      trigger,
      status: enviado ? 'enviado' : 'falhou',
      conteudo: enviado ? texto : null,
      erro,
      followup_num: count + 1,
    })

    // Só conta a tentativa e avança o relógio se o envio deu certo (idempotência)
    if (enviado) {
      const novoCount = count + 1
      const update: Record<string, unknown> = {
        followup_count: novoCount,
        ultimo_followup_em: new Date().toISOString(),
      }
      if (novoCount >= col.followup_max) update.followup_status = 'esgotado'
      await supabase.from('leads').update(update).eq('id', lead.id)

      await supabase.from('acoes_sara').insert({
        lead_id: lead.id,
        tipo: 'followup',
        conteudo: texto,
        razao: `followup_${trigger}`,
        sucesso: true,
      })
    }

    resultados.push({ lead: lead.id, trigger, enviado, erro })
  }

  return NextResponse.json({
    ok: true,
    hora_acre: hora,
    processados: resultados.length,
    enviados: resultados.filter((r) => r.enviado).length,
    resultados,
  })
}
