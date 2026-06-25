import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara } from '@/lib/sara'

const HORA_MIN = 8
const HORA_MAX = 20

function horaAtualSaoPaulo(): number {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hour12: false,
  })
  return parseInt(formatter.format(new Date()), 10)
}

type TriggerNome =
  | 'primeiro_contato_capturados'
  | 'confirmacao_visita_agendada'
  | 'followup_pos_visita'
  | 'recuperacao_repescagem'

type LeadFollowup = {
  id: string
  coluna_id: string
  familia_id: string
  ultima_interacao_em: string | null
  entrou_coluna_em: string | null
  data_proxima_acao: string | null
  ia_ativa: boolean
  familia: { telefone: string; nome_responsavel: string } | null
  coluna: { nome: string; ordem: number } | null
}

async function jaEnviouFollowupRecente(
  supabase: ReturnType<typeof createServerAdminClient>,
  leadId: string,
  trigger: TriggerNome
): Promise<boolean> {
  const limite = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('acoes_sara')
    .select('id')
    .eq('lead_id', leadId)
    .eq('tipo', 'followup')
    .ilike('razao', `followup_${trigger}%`)
    .gte('criado_em', limite)
    .limit(1)
    .maybeSingle()
  return !!data
}

function promptPorTrigger(trigger: TriggerNome, nomeResponsavel: string): string {
  switch (trigger) {
    case 'primeiro_contato_capturados':
      return `Faça o primeiro contato com ${nomeResponsavel}. A família entrou em contato mas ainda não houve atendimento. Apresente-se como Sara, consultora do Colégio Pequenos Guardiões, demonstre acolhimento cristão e pergunte sobre a criança e o que buscam na escola.`
    case 'confirmacao_visita_agendada':
      return `Faça a confirmação da visita agendada para amanhã com ${nomeResponsavel}. Seja calorosa, confirme o endereço e horário, e diga que a escola está esperando com alegria.`
    case 'followup_pos_visita':
      return `Faça um follow-up empático após a visita com ${nomeResponsavel}. Pergunte o que acharam da escola, se a criança gostou, e se têm alguma dúvida antes de tomar a decisão.`
    case 'recuperacao_repescagem':
      return `Faça uma tentativa gentil de recuperação com ${nomeResponsavel}, que está na repescagem há mais de 7 dias. Mostre que há vagas disponíveis, reforce o diferencial cristão da escola e pergunte se houve alguma preocupação que possa ser esclarecida.`
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const vercelCron = req.headers.get('x-vercel-cron')

  const autenticado =
    vercelCron === '1' ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`)

  if (!autenticado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const hora = horaAtualSaoPaulo()
  if (hora < HORA_MIN || hora >= HORA_MAX) {
    return NextResponse.json({ skipped: `fora_do_horario (${hora}h)` })
  }

  const supabase = createServerAdminClient()
  const agora = new Date()

  const { data: leads, error } = await supabase
    .from('leads')
    .select(`
      id,
      coluna_id,
      familia_id,
      ultima_interacao_em,
      entrou_coluna_em,
      data_proxima_acao,
      ia_ativa,
      familia:familias(telefone, nome_responsavel),
      coluna:colunas(nome, ordem)
    `)
    .eq('ia_ativa', true)

  if (error) {
    console.error('Erro ao buscar leads para followup:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const resultados: {
    leadId: string
    trigger: TriggerNome
    enviado: boolean
    motivo?: string
  }[] = []

  for (const lead of (leads || []) as unknown as LeadFollowup[]) {
    if (!lead.familia?.telefone) continue

    const colunaNome = lead.coluna?.nome || ''
    const ultimaInteracao = lead.ultima_interacao_em ? new Date(lead.ultima_interacao_em) : null
    const entrouColuna = lead.entrou_coluna_em ? new Date(lead.entrou_coluna_em) : null

    const interagiu12h =
      ultimaInteracao && agora.getTime() - ultimaInteracao.getTime() < 12 * 60 * 60 * 1000
    if (interagiu12h) continue

    let trigger: TriggerNome | null = null

    if (colunaNome === 'Capturados') {
      const { data: msgsSaida } = await supabase
        .from('mensagens')
        .select('id')
        .eq('lead_id', lead.id)
        .in('direcao', ['out_ia', 'out_humano'])
        .gte('criado_em', new Date(agora.getTime() - 4 * 60 * 60 * 1000).toISOString())
        .limit(1)
        .maybeSingle()

      if (!msgsSaida) {
        trigger = 'primeiro_contato_capturados'
      }
    } else if (colunaNome === 'Visita Agendada' && lead.data_proxima_acao) {
      const dataVisita = new Date(lead.data_proxima_acao)
      const amanha = new Date(agora)
      amanha.setDate(amanha.getDate() + 1)
      if (
        dataVisita.getFullYear() === amanha.getFullYear() &&
        dataVisita.getMonth() === amanha.getMonth() &&
        dataVisita.getDate() === amanha.getDate()
      ) {
        trigger = 'confirmacao_visita_agendada'
      }
    } else if (colunaNome === 'Visita Realizada' && entrouColuna) {
      const horasNaColuna = (agora.getTime() - entrouColuna.getTime()) / (60 * 60 * 1000)
      if (horasNaColuna >= 24) {
        trigger = 'followup_pos_visita'
      }
    } else if (colunaNome === 'Repescagem' && entrouColuna) {
      const diasNaColuna = (agora.getTime() - entrouColuna.getTime()) / (24 * 60 * 60 * 1000)
      if (diasNaColuna >= 7) {
        trigger = 'recuperacao_repescagem'
      }
    }

    if (!trigger) continue

    const jaEnviou = await jaEnviouFollowupRecente(supabase, lead.id, trigger)
    if (jaEnviou) {
      resultados.push({ leadId: lead.id, trigger, enviado: false, motivo: 'ja_enviado_48h' })
      continue
    }

    try {
      const promptAdicional = promptPorTrigger(trigger, lead.familia.nome_responsavel)
      const saraResult = await gerarRespostaSara(lead.id, undefined, undefined, promptAdicional)
      const sent = await evolutionSendText(lead.familia.telefone, saraResult.resposta)

      await supabase.from('mensagens').insert({
        lead_id: lead.id,
        direcao: 'out_ia',
        conteudo: saraResult.resposta,
        whatsapp_message_id: sent?.key?.id || null,
      })

      await supabase
        .from('leads')
        .update({ ultima_interacao_em: new Date().toISOString() })
        .eq('id', lead.id)

      await supabase.from('acoes_sara').insert({
        lead_id: lead.id,
        tipo: 'followup',
        conteudo: saraResult.resposta,
        razao: `followup_${trigger}`,
        sucesso: true,
      })

      resultados.push({ leadId: lead.id, trigger, enviado: true })
    } catch (e) {
      console.error(`Follow-up falhou para lead ${lead.id}:`, e)
      const msg = e instanceof Error ? e.message : 'erro desconhecido'

      await supabase.from('acoes_sara').insert({
        lead_id: lead.id,
        tipo: 'followup',
        conteudo: null,
        razao: `followup_${trigger}`,
        sucesso: false,
      })

      resultados.push({ leadId: lead.id, trigger, enviado: false, motivo: msg })
    }
  }

  return NextResponse.json({
    ok: true,
    hora_sp: hora,
    processados: resultados.length,
    enviados: resultados.filter((r) => r.enviado).length,
    resultados,
  })
}
