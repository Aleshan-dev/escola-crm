import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara } from '@/lib/sara'
import {
  dentroHorarioComercial,
  deveMarcarPerdidoPorSilencio,
  DIAS_SILENCIO_PERDIDO,
  ehVisitaAmanha,
  estaDevido,
  horaAcre,
  promptPorTrigger,
  respondeuAposFollowup,
  triggerPorColuna,
  type TriggerNome,
} from '@/lib/followup-regras'
import { MAX_ENVIOS_POR_EXECUCAO, jitterMs, sleep } from '@/lib/pacing'
import { registrarAlerta } from '@/lib/alertas'
import { notificarGestor } from '@/lib/notificacoes'

// Dá margem para o pacing (jitter entre envios) sem estourar o tempo da função.
export const maxDuration = 30

// ADR-004: o cron decide QUANDO agir (regras determinísticas em followup-regras.ts);
// a Sara decide O QUE dizer.

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

const ms = (iso: string | null): number => (iso ? new Date(iso).getTime() : 0)

type LeadSilencio = {
  id: string
  coluna_id: string
  ultimo_followup_em: string | null
  familia: { nome_responsavel: string | null; telefone: string | null } | null
}

/** Move para "Perdidos" leads que esgotaram os follow-ups e ficaram N dias sem responder. */
async function marcarPerdidosPorSilencio(
  supabase: ReturnType<typeof createServerAdminClient>,
  agora: number
): Promise<number> {
  const { data: colunas } = await supabase.from('colunas').select('id, nome')
  if (!colunas) return 0
  const cols = colunas as { id: string; nome: string }[]
  const perdidos = cols.find((c) => /perdid/i.test(c.nome))
  if (!perdidos) return 0
  const terminaisIds = new Set(cols.filter((c) => /matric|perdid/i.test(c.nome)).map((c) => c.id))

  const { data: candidatos } = await supabase
    .from('leads')
    .select('id, coluna_id, ultimo_followup_em, familia:familias(nome_responsavel, telefone)')
    .eq('followup_status', 'esgotado')
    .eq('arquivado', false)

  let movidos = 0
  for (const l of (candidatos || []) as unknown as LeadSilencio[]) {
    if (terminaisIds.has(l.coluna_id)) continue
    if (!deveMarcarPerdidoPorSilencio(ms(l.ultimo_followup_em), agora)) continue

    await supabase
      .from('leads')
      .update({
        coluna_id: perdidos.id,
        entrou_coluna_em: new Date().toISOString(),
        motivo_perda: 'Sem resposta após follow-ups',
      })
      .eq('id', l.id)

    await supabase.from('acoes_sara').insert({
      lead_id: l.id,
      tipo: 'movimentacao',
      conteudo: `Perdido automaticamente: sem resposta por ${DIAS_SILENCIO_PERDIDO} dias após os follow-ups`,
      razao: 'sem_resposta',
      sucesso: true,
      coluna_origem_id: l.coluna_id,
      coluna_destino_id: perdidos.id,
    })

    await supabase.from('eventos_timeline').insert({
      lead_id: l.id,
      tipo: 'movimentacao',
      descricao: `Movido para "Perdidos" automaticamente — sem resposta por ${DIAS_SILENCIO_PERDIDO} dias após os follow-ups.`,
    })

    await notificarGestor(
      supabase,
      'encerramento',
      `🚫 *Atendimento encerrado — Perdido*\nFamília: ${l.familia?.nome_responsavel || 'Família'}\nMotivo: sem resposta após follow-ups`
    )
    movidos++
  }
  return movidos
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const vercelCron = req.headers.get('x-vercel-cron')
  const autenticado = vercelCron === '1' || (!!cronSecret && authHeader === `Bearer ${cronSecret}`)
  if (!autenticado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const agora = Date.now()
  if (!dentroHorarioComercial(agora)) {
    return NextResponse.json({ skipped: `fora_do_horario_comercial (${horaAcre(agora)}h Acre)` })
  }

  const supabase = createServerAdminClient()

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
    await registrarAlerta(supabase, 'cron/followup', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const resultados: Resultado[] = []
  let enviados = 0

  for (const lead of (leadsRaw || []) as unknown as LeadRow[]) {
    if (enviados >= MAX_ENVIOS_POR_EXECUCAO) break // pacing: resto fica para a próxima execução
    const tel = lead.familia?.telefone
    const col = lead.coluna
    if (!tel || !col) continue

    const intervaloBase = col.followup_intervalo_horas
    if (intervaloBase == null) continue // etapa sem follow-up (ex.: Matriculados, Perdidos)

    if (lead.followup_count >= col.followup_max) {
      await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
      resultados.push({ lead: lead.id, skip: 'esgotado' })
      continue
    }

    const ultimaInteracaoMs = ms(lead.ultima_interacao_em)
    const ultimoFollowupMs = ms(lead.ultimo_followup_em)
    const entrouColunaMs = ms(lead.entrou_coluna_em)

    // Reengajou: respondeu depois do último follow-up -> zera o contador
    let count = lead.followup_count
    if (respondeuAposFollowup(ultimaInteracaoMs, ultimoFollowupMs) && count > 0) {
      count = 0
      await supabase.from('leads').update({ followup_count: 0 }).eq('id', lead.id)
    }

    const trigger = triggerPorColuna(col.nome)

    if (trigger === 'confirmacao_visita') {
      if (!lead.data_proxima_acao) continue
      if (!ehVisitaAmanha(ms(lead.data_proxima_acao), agora)) continue
      if (ultimoFollowupMs > agora - 20 * 60 * 60 * 1000) continue // não confirma 2x no mesmo dia
    } else {
      const devido = estaDevido(
        { ultimaInteracaoMs, ultimoFollowupMs, entrouColunaMs, intervaloBaseHoras: intervaloBase, count },
        agora
      )
      if (!devido) continue
    }

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

    await supabase.from('followup_log').insert({
      lead_id: lead.id,
      trigger,
      status: enviado ? 'enviado' : 'falhou',
      conteudo: enviado ? texto : null,
      erro,
      followup_num: count + 1,
    })

    // Número inexistente no WhatsApp: para de tentar esse lead (ADR-005).
    if (!enviado && /"exists"\s*:\s*false/.test(erro || '')) {
      await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
      resultados.push({ lead: lead.id, trigger, enviado: false, skip: 'numero_inexistente' })
      continue
    }

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

      // Pacing anti-bloqueio: intervalo aleatório antes do próximo envio
      enviados++
      if (enviados < MAX_ENVIOS_POR_EXECUCAO) await sleep(jitterMs())
    }

    resultados.push({ lead: lead.id, trigger, enviado, erro })
  }

  // Encerra por silêncio: leads que esgotaram os follow-ups e ficaram N dias sem responder.
  let perdidosPorSilencio = 0
  try {
    perdidosPorSilencio = await marcarPerdidosPorSilencio(supabase, agora)
  } catch (e) {
    console.error('Falha ao marcar perdidos por silêncio:', e)
    await registrarAlerta(supabase, 'cron/followup', e instanceof Error ? e.message : 'perdidos_por_silencio')
  }

  return NextResponse.json({
    ok: true,
    hora_acre: horaAcre(agora),
    processados: resultados.length,
    enviados: resultados.filter((r) => r.enviado).length,
    perdidos_por_silencio: perdidosPorSilencio,
    resultados,
  })
}
