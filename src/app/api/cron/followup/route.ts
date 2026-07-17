import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { enviarTextoWhatsApp, enviarTemplateWhatsApp } from '@/lib/whatsapp-cloud'
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
import { dividirEmBaloes } from '@/lib/atendimento'
import { ACRE_SHIFT_MS } from '@/lib/disponibilidade'

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
  familia: { telefone: string; nome_responsavel: string; whatsapp_phone_number_id: string | null } | null
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

// 1º follow-up pós-visita: ~1h após o lead entrar no quadro "Visita Realizada".
const POS_VISITA_APOS_MOVER_MS = 60 * 60 * 1000

// Fora da janela de 24h o envio livre falha; recai num template aprovado.
// Retorna null p/ gatilhos perto da visita (quase sempre dentro da janela) —
// aí um texto de template genérico soaria errado, melhor não enviar.
function templateFallbackDoTrigger(
  triggerLog: string,
  nome: string
): { name: string; variaveis: string[] } | null {
  if (triggerLog === 'followup_pos_visita') return { name: 'retorno_visita', variaveis: [nome] }
  if (['primeiro_contato', 'recuperacao', 'reengajamento'].includes(triggerLog))
    return { name: 'retomada_lead', variaveis: [nome] }
  return null
}

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
       familia:familias(telefone, nome_responsavel, whatsapp_phone_number_id),
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
    let triggerLog: string = trigger
    let promptFollowup = promptPorTrigger(trigger, lead.familia!.nome_responsavel, count + 1)

    if (trigger === 'confirmacao_visita') {
      // Baseia os lembretes na TAREFA de visita (cobre visitas manuais/reagendadas).
      const { data: visita } = await supabase
        .from('tarefas')
        .select('data_hora')
        .eq('lead_id', lead.id)
        .eq('tipo', 'visita')
        .eq('concluida', false)
        .gte('data_hora', new Date(agora - 60 * 60 * 1000).toISOString())
        .order('data_hora', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (!visita) continue
      const visitaMs = ms(visita.data_hora)
      const minAte = (visitaMs - agora) / 60000

      if (minAte >= 15 && minAte <= 90) {
        // Lembrete de ~1 hora antes — no máx. 1 por visita (dedup nas últimas 3h).
        const { count: jaEnviou } = await supabase
          .from('followup_log')
          .select('id', { count: 'exact', head: true })
          .eq('lead_id', lead.id)
          .eq('trigger', 'lembrete_1h')
          .gte('criado_em', new Date(agora - 3 * 60 * 60 * 1000).toISOString())
        if (jaEnviou) continue
        const wall = new Date(visitaMs + ACRE_SHIFT_MS)
        const horaVisita = `${String(wall.getUTCHours()).padStart(2, '0')}:${String(wall.getUTCMinutes()).padStart(2, '0')}`
        triggerLog = 'lembrete_1h'
        promptFollowup = `Envie um lembrete curto e caloroso para ${lead.familia!.nome_responsavel}: a visita ao Colégio Pequenos Guardiões é HOJE, daqui a cerca de 1 hora, às ${horaVisita}. Confirme que a escola está esperando por ela.`
      } else if (ehVisitaAmanha(visitaMs, agora)) {
        // Lembrete de véspera — 1x por dia.
        if (ultimoFollowupMs > agora - 20 * 60 * 60 * 1000) continue
      } else {
        continue
      }
    } else if (trigger === 'followup_pos_visita' && count === 0) {
      // 1º pós-visita: ~1h depois de entrar em "Visita Realizada", independentemente
      // da última interação (o gestor quer o retorno logo após a visita). Janela de
      // 1h a 3 dias — evita ressuscitar leads parados há muito tempo no quadro.
      const desde = agora - entrouColunaMs
      if (entrouColunaMs === 0 || desde < POS_VISITA_APOS_MOVER_MS || desde > 3 * 24 * 60 * 60 * 1000) continue
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
    let viaTemplate = false
    try {
      const saraResult = await gerarRespostaSara(lead.id, undefined, undefined, promptFollowup)
      texto = saraResult.resposta
      const baloes = dividirEmBaloes(texto)
      for (let i = 0; i < baloes.length; i++) {
        const wid = await enviarTextoWhatsApp(tel, baloes[i], lead.familia?.whatsapp_phone_number_id)
        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          conteudo: baloes[i],
          whatsapp_message_id: wid,
        })
        if (i < baloes.length - 1) await sleep(900)
      }
      enviado = true
    } catch (e) {
      erro = e instanceof Error ? e.message : 'erro desconhecido'
      console.error(`Follow-up falhou para lead ${lead.id}:`, erro)

      // Fora da janela de 24h o envio livre falha -> tenta o template aprovado.
      const tf = templateFallbackDoTrigger(triggerLog, lead.familia!.nome_responsavel)
      if (tf) {
        try {
          const wid = await enviarTemplateWhatsApp(
            tel, tf.name, 'pt_BR', tf.variaveis, lead.familia?.whatsapp_phone_number_id
          )
          await supabase.from('mensagens').insert({
            lead_id: lead.id,
            direcao: 'out_ia',
            conteudo: `[template: ${tf.name}]`,
            whatsapp_message_id: wid,
          })
          enviado = true
          viaTemplate = true
          erro = null
          triggerLog = `${triggerLog}_template`
        } catch (e2) {
          erro = `${erro} | template ${tf.name}: ${e2 instanceof Error ? e2.message : 'erro'}`
        }
      }
    }

    await supabase.from('followup_log').insert({
      lead_id: lead.id,
      trigger: triggerLog,
      status: enviado ? 'enviado' : 'falhou',
      conteudo: enviado ? (viaTemplate ? `[template] ${texto}` : texto) : null,
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
        razao: `followup_${triggerLog}`,
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
