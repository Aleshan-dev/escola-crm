import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { canalDeSaida } from '@/lib/whatsapp-cloud'
import { carimboCanal, enviarPeloCanal } from '@/lib/canais/enviar'
import { enviarProtegido, preChecarEnvio } from '@/lib/envio/portao'
import { ehErroJanela, janelaAberta } from '@/lib/janela'
import { gerarRespostaSara } from '@/lib/sara'
import {
  dentroHorarioComercial,
  deveMarcarPerdidoPorSilencio,
  DIAS_SILENCIO_PERDIDO,
  ehVisitaAmanha,
  estaDevido,
  estaDevidoPosVisita,
  horaAcre,
  POS_VISITA_MAX_TOQUES,
  promptPorTrigger,
  promptPosVisitaPorToque,
  reativacaoDevida,
  respondeuAposFollowup,
  triggerPorColuna,
  type TriggerNome,
} from '@/lib/followup-regras'
import { MAX_ENVIOS_POR_EXECUCAO, jitterMs, sleep } from '@/lib/pacing'
import { registrarAlerta } from '@/lib/alertas'
import { notificarGestor } from '@/lib/notificacoes'
import { dividirEmBaloes } from '@/lib/atendimento'
import { ACRE_SHIFT_MS } from '@/lib/disponibilidade'
import { enviarResumosPreVisita } from '@/lib/lembrete-visita'
import { promptConviteLigacao } from '@/lib/ligacao-direcao'

// Dá margem para o pacing (jitter entre envios) sem estourar o tempo da função.
// 21/10/2026: com tudo saindo pelo WAHA (check-exists + envio ~4-5s por balão) e o
// portão de envio, 30s não cabia nem um lead — TODA rodada morria no meio (balão 1
// entregue, sem followup_log nem contador → risco de repetir). Teto maior + orçamento
// interno (ORCAMENTO_MS) para não começar lead novo perto do limite.
export const maxDuration = 120
const ORCAMENTO_MS = 80_000

// Teto de toques SEM RESPOSTA do CHASE FRIO ao longo da jornada inteira (não zera na
// troca de coluna; zera quando o lead responde — reset no inbound em atendimento.ts).
// Evita o lead perseguido por várias etapas sem nunca responder (o caso "Ravi", ~11 toques).
const TETO_JORNADA_SEM_RESPOSTA = 5

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
  followup_sem_resposta: number
  ultimo_followup_em: string | null
  followup_status: string
  no_show_em: string | null
  reagendamentos_count: number | null
  visita_confirmada_em: string | null
  reativar_em: string | null
  reativar_motivo: string | null
  convite_ligacao_em: string | null
  convite_ligacao_enviado_em: string | null
  familia: { telefone: string; nome_responsavel: string; whatsapp_phone_number_id: string | null; canal_whatsapp: string | null } | null
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
  const { data: colunas } = await supabase.from('colunas').select('id, nome, funil_id')
  if (!colunas) return 0
  const cols = colunas as { id: string; nome: string; funil_id: string }[]
  // O nome "Perdidos" se repete entre funis (Captação, Campanha 2027...). Move o lead
  // para o "Perdidos" DO PRÓPRIO funil — nunca para o de outro funil.
  const perdidosPorFunil = new Map<string, string>()
  for (const c of cols) if (/perdid/i.test(c.nome)) perdidosPorFunil.set(c.funil_id, c.id)
  if (perdidosPorFunil.size === 0) return 0
  const funilDaColuna = new Map<string, string>(cols.map((c) => [c.id, c.funil_id]))
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

    const perdidosId = perdidosPorFunil.get(funilDaColuna.get(l.coluna_id) ?? '')
    if (!perdidosId) continue // funil do lead sem coluna "Perdidos": não move

    await supabase
      .from('leads')
      .update({
        coluna_id: perdidosId,
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
      coluna_destino_id: perdidosId,
    })

    await supabase.from('eventos_timeline').insert({
      lead_id: l.id,
      tipo: 'movido_coluna',
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

/**
 * Follow-up cuja janela de 24h (WhatsApp oficial) está FECHADA: não há como enviar
 * texto livre. Em vez de o toque sumir, ESCALA para humano (2026-09-22, pedido do
 * gestor): (1) TRANSBORDO — marca o lead para atendimento humano, o que o tira do
 * follow-up automático e evita a Sara responder por cima; (2) um ALERTA
 * "follow-up pendente" com a mensagem pronta para copiar e colar (um por follow-up).
 * Não mexe em ia_ativa (precisa_atendimento_humano já pausa a Sara e o cron), para o
 * humano reativar com um clique depois de resolver.
 */
async function escalarFollowupJanelaFechada(
  supabase: ReturnType<typeof createServerAdminClient>,
  p: { leadId: string; telefone: string; nome: string; texto: string; trigger: string; semTransbordo?: boolean }
): Promise<void> {
  const { leadId, telefone, nome, texto, trigger, semTransbordo } = p

  // PÓS-VISITA (semTransbordo): NÃO manda o lead para transbordo. A régua de pós-visita
  // são 5 toques em 14 dias e quase todos caem fora da janela de 24h; se cada toque
  // pusesse o lead em transbordo (precisa_atendimento_humano=true), ele sairia da fila
  // do cron e os toques seguintes nunca sairiam. Aqui só criamos o alerta manual e
  // deixamos o lead na régua — o dedup por followup_log evita repetir o mesmo toque.
  if (!semTransbordo) {
    await supabase
      .from('leads')
      .update({
        precisa_atendimento_humano: true,
        motivo_transbordo: 'Follow-up pendente — janela de 24h fechada (enviar manualmente)',
        transbordo_em: new Date().toISOString(),
      })
      .eq('id', leadId)
  }

  // Um ALERTA por follow-up, com a mensagem PRONTA para copiar e colar. A família
  // está fora da janela de 24h, então o envio é manual pelo WhatsApp oficial.
  const nota = semTransbordo
    ? 'Janela de 24h fechada; envie manualmente pelo WhatsApp oficial (o lead segue na régua de pós-visita).'
    : 'Janela de 24h fechada, lead em transbordo.'
  await registrarAlerta(
    supabase,
    'follow-up-pendente',
    `📋 Follow-up pendente (${trigger}) — ${nome} (${telefone}). ${nota} Copie e cole no WhatsApp oficial:\n\n${texto}`,
    { tipo: 'engajamento', leadId }
  )

  await supabase.from('eventos_timeline').insert({
    lead_id: leadId,
    tipo: semTransbordo ? 'followup' : 'transbordo',
    descricao: semTransbordo
      ? `Follow-up (${trigger}) fora da janela de 24h — alerta de envio manual criado; lead mantido na régua de pós-visita.`
      : `Follow-up (${trigger}) não enviado — janela de 24h fechada. Transbordo + tarefa de envio manual criados.`,
  })
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const vercelCron = req.headers.get('x-vercel-cron')
  const autenticado = vercelCron === '1' || (!!cronSecret && authHeader === `Bearer ${cronSecret}`)
  if (!autenticado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }
  // Resumo pré-visita (~30 min antes) roda por aqui (*/15, boa precisão) e também no
  // heartbeat (*/30, rede de segurança). Independe de followup_ativo, então sai antes
  // do núcleo e não é afetado pelos gates dele. Best-effort: não derruba o follow-up.
  const resumoVisitas = await enviarResumosPreVisita(createServerAdminClient()).catch((e) => ({
    erro: e instanceof Error ? e.message : String(e),
  }))
  const followup = await executarFollowup()
  return NextResponse.json({ resumoVisitas, followup })
}

// Núcleo do follow-up, chamável pelo cron GET acima E EM PROCESSO pelo heartbeat
// (rede de segurança se o cron dedicado da Vercel morrer sozinho — ADR-008; já
// aconteceu 23/07, 10/09). Roda a lógica direto, sem o salto HTTP frágil que dependia
// de NEXT_PUBLIC_APP_URL/CRON_SECRET/SSO. Auto-gateia em horário comercial e
// followup_ativo, então é seguro chamar de qualquer origem já autenticada.
export async function executarFollowup(agora: number = Date.now()) {
  const inicioExecucao = Date.now()
  // ANTI-NO-SHOW (06/11/2026): antes, fora do horário comercial (8h–20h Acre) o cron
  // retornava aqui e NADA rodava. Isso derrubava o lembrete de ~1h antes das visitas
  // CEDO (ex.: 07:30): ele cairia ~06:30, antes das 8h, e nunca saía — a família só
  // recebia a véspera e, sem resposta, faltava (os 2 no-shows de 03–06/11 eram ambos
  // 07:30). Agora, FORA do horário, só o lembrete de visita IMINENTE passa (a família
  // agendou essa visita — não é abordagem fria); todo o resto (recuperação,
  // reengajamento, pós-visita, véspera, resgate de no-show, "Perdidos") segue preso ao
  // horário comercial, pelos guards `foraDoHorario` abaixo.
  const foraDoHorario = !dentroHorarioComercial(agora)

  const supabase = createServerAdminClient()

  // Gate liga/desliga: o follow-up automático só roda com config_ia.followup_ativo=true.
  // Formaliza o "parado de propósito" (migração para o Cloud) num interruptor único,
  // o mesmo que o heartbeat (/api/cron/heartbeat) usa para saber se deve vigiar.
  const { data: cfgFollowup } = await supabase
    .from('config_ia')
    .select('followup_ativo')
    .eq('id', 1)
    .maybeSingle<{ followup_ativo: boolean }>()
  if (!cfgFollowup?.followup_ativo) {
    return { skipped: 'followup_desligado' }
  }

  // LOCK DE EXECUÇÃO (07/11/2026): o cron dedicado (*/15) e o heartbeat (*/30) chamam este
  // núcleo; em :00 e :30 os dois rodam JUNTOS. Sem trava, as duas execuções leem o mesmo
  // lead "devido" e disparam o follow-up em dobro — e a out_ia da 1ª bumpa
  // leads.ultima_interacao_em (trigger trg_ultima_interacao), mudando a chave de
  // idempotência de envio (envio_idempotencia) da 2ª, que então fura a dedupe e reenvia
  // (pares idênticos em segundos; e os turnos de 16–24 balões empilhados). Claim-lock
  // atômico em config_ia.followup_execucao_em: só UMA execução casa o WHERE (nulo ou
  // vencido) e segue; a concorrente atualiza 0 linhas e sai. TTL de 6 min > maxDuration
  // (300s), então nunca corta uma execução viva; e os ticks da mesma origem distam ≥15 min,
  // então não há starvation. Se o cron dedicado morrer, o heartbeat acha a trava vencida e
  // assume (ADR-008 preservado).
  // A coluna é mantida não-nula (backfill em 2000-01-01), então o filtro `.lt` sozinho
  // cobre o caso inicial sem precisar de `.or(...is.null)` — cuja string, se malformada,
  // poderia errar o update e, no fail-closed, matar o motor em silêncio.
  const LOCK_TTL_MS = 6 * 60 * 1000
  const limiteLock = new Date(agora - LOCK_TTL_MS).toISOString()
  const { data: lock, error: lockErr } = await supabase
    .from('config_ia')
    .update({ followup_execucao_em: new Date().toISOString() })
    .eq('id', 1)
    .lt('followup_execucao_em', limiteLock)
    .select('id')
  // FAIL-OPEN: só PULA quando a trava está claramente viva (update ok e 0 linhas casadas).
  // Se o update ERROU, segue mesmo assim — um defeito na trava nunca pode calar o follow-up.
  if (!lockErr && Array.isArray(lock) && lock.length === 0) {
    return { skipped: 'execucao_concorrente' }
  }

  const { data: leadsRaw, error } = await supabase
    .from('leads')
    .select(
      `id, coluna_id, familia_id, ultima_interacao_em, entrou_coluna_em, data_proxima_acao,
       followup_count, followup_sem_resposta, ultimo_followup_em, followup_status,
       no_show_em, reagendamentos_count, visita_confirmada_em,
       reativar_em, reativar_motivo, convite_ligacao_em, convite_ligacao_enviado_em,
       familia:familias(telefone, nome_responsavel, whatsapp_phone_number_id, canal_whatsapp),
       coluna:colunas(nome, ordem, followup_intervalo_horas, followup_max)`
    )
    .eq('ia_ativa', true)
    .eq('followup_status', 'ativo')
    .eq('arquivado', false)
    .neq('precisa_atendimento_humano', true)
    // ENCERRAMENTO DE ATENDIMENTO (2026-08-13): o gestor (ou a Sara, com confirmação)
    // pode encerrar o atendimento de um lead. Encerrado = fora do follow-up proativo,
    // mesmo que a família volte a responder (o webhook reseta followup_status='ativo'
    // a cada mensagem recebida, por isso o "encerrado" NÃO pode morar em followup_status
    // — mora em followup_encerrado_em, que o webhook não toca). A Sara continua
    // REATIVA para esses leads; só a perseguição automática para.
    .is('followup_encerrado_em', null)
    // AUDITORIA CMO 2026-07-29 — sem ORDER BY o Postgres devolve ordem arbitrária,
    // e o `break` no teto de MAX_ENVIOS_POR_EXECUCAO servia sempre os mesmos leads,
    // deixando os outros famintos. Havia lead com 10 dias de silêncio e ZERO
    // follow-ups enquanto outro já tinha recebido 3. Quem está calado há mais
    // tempo é atendido primeiro.
    .order('ultima_interacao_em', { ascending: true, nullsFirst: true })

  if (error) {
    console.error('Erro ao buscar leads para follow-up:', error)
    await registrarAlerta(supabase, 'cron/followup', error.message)
    return { error: error.message }
  }

  // CASOS: lead com Caso esperando a equipe fica fora do follow-up — a família está
  // aguardando uma resposta da escola, e um "ainda tem interesse?" agora seria uma
  // segunda voz automática atravessando o retorno. (Sem a função ligada, não há Casos.)
  const { data: casosEsperando } = await supabase
    .from('casos')
    .select('lead_id')
    .eq('estado', 'aguardando_equipe')
  const comCasoEsperando = new Set((casosEsperando ?? []).map((c: { lead_id: string }) => c.lead_id))

  // Coluna "No Show": para onde o auto-detector move o lead quando a visita passa +1h
  // sem ter sido marcada "realizada". Nome fixo do Kanban (ver triggerPorColuna).
  const { data: colNoShow } = await supabase
    .from('colunas')
    .select('id')
    .eq('nome', 'No Show')
    .maybeSingle<{ id: string }>()
  const noShowColunaId = colNoShow?.id ?? null

  const resultados: Resultado[] = []
  let enviados = 0
  let toques = 0

  for (const lead of (leadsRaw || []) as unknown as LeadRow[]) {
    if (comCasoEsperando.has(lead.id)) {
      resultados.push({ lead: lead.id, skip: 'caso_aguardando_equipe' })
      continue
    }
    // Teto por execução: conta TODA geração da Sara (LLM), não só os envios reais.
    // Fora da janela o toque vira alerta manual (não incrementa `enviados`), mas a
    // chamada ao LLM acontece igual. Sem contar isso, um backlog grande fazia dezenas
    // de gerações numa mesma execução e estourava o maxDuration de 30s (504). O resto
    // fica para a próxima rodada (a cada 15 min), drenando ~MAX por vez.
    if (toques >= MAX_ENVIOS_POR_EXECUCAO) break
    // Orçamento de tempo: um lead (geração + balões pelo WAHA) leva ~20-30s; não
    // começa outro se não houver folga até o maxDuration.
    if (Date.now() - inicioExecucao > ORCAMENTO_MS) break
    const tel = lead.familia?.telefone
    const col = lead.coluna
    if (!tel || !col) continue

    // CONVITE DE LIGAÇÃO DA DIREÇÃO (26/11/2026): a equipe marcou o lead
    // (leads.convite_ligacao_em) e o convite ainda não saiu. É UM toque pedido pela
    // equipe, então passa por cima da cadência da coluna (inclusive Perdidos) e dos
    // tetos de chase frio — mas segue a janela 8h–20h e o portão anti-bloqueio.
    // Depois de enviado, a Sara agenda a ligação quando a família responder
    // (src/lib/ligacao-direcao.ts).
    const conviteLigacao = !!lead.convite_ligacao_em && !lead.convite_ligacao_enviado_em

    if (col.followup_intervalo_horas == null && !conviteLigacao) continue // etapa sem follow-up (ex.: Matriculados, Perdidos)
    // Só o convite de ligação passa sem intervalo, e ele não usa a cadência da coluna.
    const intervaloBase = col.followup_intervalo_horas ?? 0

    const trigger = triggerPorColuna(col.nome)

    // Fora do horário comercial (ver topo), só o lembrete de visita IMINENTE passa;
    // todo o resto espera a janela de 8h–20h.
    if (foraDoHorario && (conviteLigacao || trigger !== 'confirmacao_visita')) continue

    // O pós-visita se controla pelo PRÓPRIO cronograma (POS_VISITA_TOQUES_HORAS), não
    // pelo par followup_count/followup_max — por isso fica de fora deste guard genérico.
    if (!conviteLigacao && trigger !== 'followup_pos_visita' && lead.followup_count >= col.followup_max) {
      await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
      resultados.push({ lead: lead.id, skip: 'esgotado' })
      continue
    }

    // TETO DE JORNADA (08/11/2026): followup_sem_resposta persiste pela jornada toda (não
    // zera na troca de coluna; só quando o lead responde — reset no inbound em
    // atendimento.ts). O par followup_count/followup_max é POR coluna e zera a cada etapa,
    // então um lead frio perseguido por Em Atendimento → No Show → Repescagem acumulava
    // ~11 toques sem nunca responder. No CHASE FRIO paramos ao atingir o teto; as sequências
    // quentes (confirmação de visita, pós-visita, resgate de no-show, reengajamento
    // combinado) seguem com seus próprios limites.
    const triggerFrio =
      trigger === 'primeiro_contato' || trigger === 'reengajamento' || trigger === 'recuperacao'
    if (!conviteLigacao && triggerFrio && (lead.followup_sem_resposta ?? 0) >= TETO_JORNADA_SEM_RESPOSTA) {
      await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
      resultados.push({ lead: lead.id, skip: 'teto_jornada' })
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

    // Nº de toques de pós-visita já enviados NESTA entrada na coluna (índice do próximo
    // no cronograma). Preenchido no ramo do pós-visita abaixo; usado no log e no avanço.
    let toquesPosVisita = 0
    let triggerLog: string = trigger
    let promptFollowup = promptPorTrigger(trigger, lead.familia!.nome_responsavel, count + 1)

    if (conviteLigacao) {
      triggerLog = 'convite_ligacao'
      promptFollowup = promptConviteLigacao(lead.familia!.nome_responsavel)
    } else if (trigger === 'confirmacao_visita') {
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

      if (visita) {
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
          // Risco de no-show: perto da hora e ainda sem confirmação de presença.
          // Além de marcar o risco, avisa o gestor para uma ligação rápida — a ligação
          // humana derruba o no-show melhor que qualquer balão. Só 1x por visita (o
          // dedup do lembrete_1h acima garante que este bloco roda uma única vez).
          if (!lead.visita_confirmada_em) {
            await supabase.from('leads').update({ risco_no_show: true }).eq('id', lead.id)
            await notificarGestor(
              supabase,
              'visita',
              `📞 *Visita sem confirmação* — ${lead.familia?.nome_responsavel || 'a família'} tem visita HOJE às ${horaVisita} e ainda NÃO confirmou presença. Vale uma ligação rápida agora (${tel}) para confirmar e evitar o no-show.`
            ).catch(() => {})
          }
        } else if (ehVisitaAmanha(visitaMs, agora)) {
          // Véspera é envio ativo: só em horário comercial (nunca de madrugada).
          if (foraDoHorario) continue
          // Já confirmou ESTA visita? Não re-peça confirmação. Sem esta guarda, a
          // véspera pedia "confirme, por favor" de uma visita já confirmada — o lead
          // da Jessica (556993762605, 11/09) respondeu "De novo toda hora / Kkk".
          // Janela de 3 dias antes da visita = "confirmado para este ciclo" (cobre
          // reagendamento: um novo aceite re-grava visita_confirmada_em e re-silencia;
          // uma confirmação velha, anterior à janela, ainda deixa re-perguntar).
          if (
            lead.visita_confirmada_em &&
            ms(lead.visita_confirmada_em) >= visitaMs - 3 * 24 * 60 * 60 * 1000
          ) {
            continue
          }
          // Lembrete de véspera (confirmação ativa "responde SIM") — 1x por dia.
          if (ultimoFollowupMs > agora - 20 * 60 * 60 * 1000) continue
        } else {
          continue
        }
      } else {
        // Resgate de no-show é envio ativo: fora do horário comercial, espera a próxima
        // rodada dentro da janela de 8h–20h (nunca de madrugada).
        if (foraDoHorario) continue
        // Sem visita futura: possível NO-SHOW. A visita só vira no-show +2h DEPOIS do
        // horário (o fuso é o do Google Agenda / Acre, corrigido já na gravação — ver
        // atendimento.ts) e com o lead ainda em "Visita Agendada". A janela de 2h dá
        // tempo de a família chegar/atrasar e de o gestor marcar a visita como realizada
        // (ou movê-la para "Visita Realizada" — aí o lead nem cai neste trigger) ANTES
        // de qualquer "você faltou". O que estourava antes não era a régua de +2h em si,
        // e sim a hora-de-parede gravada 5h cedo, que fazia o resgate sair na HORA da
        // visita (caso Aline, 27/10) — isso foi corrigido na gravação.
        const { data: passada } = await supabase
          .from('tarefas')
          .select('id, data_hora')
          .eq('lead_id', lead.id)
          .eq('tipo', 'visita')
          .eq('concluida', false)
          .lt('data_hora', new Date(agora - 2 * 60 * 60 * 1000).toISOString())
          .gte('data_hora', new Date(agora - 7 * 24 * 60 * 60 * 1000).toISOString())
          .order('data_hora', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!passada) continue

        // Teto de 2 reagendamentos: esgota e deixa cair no "Perdido" por silêncio.
        if ((lead.reagendamentos_count ?? 0) >= 2) {
          await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
          resultados.push({ lead: lead.id, skip: 'no_show_esgotado' })
          continue
        }
        // Primeira detecção (+2h após o horário): marca a visita como ausente, MOVE o
        // lead para a coluna "No Show", zera o contador e dispara o resgate na hora. Se
        // a família tivesse comparecido, o gestor teria marcado "realizada" / movido
        // para "Visita Realizada" — e não chegaríamos até aqui.
        if (!lead.no_show_em) {
          await supabase
            .from('tarefas')
            .update({ concluida: true, status: 'ausente' })
            .eq('id', passada.id)
          const moveParaNoShow = !!noShowColunaId && lead.coluna_id !== noShowColunaId
          const patch: Record<string, unknown> = { no_show_em: new Date().toISOString(), followup_count: 0 }
          if (moveParaNoShow) {
            patch.coluna_id = noShowColunaId
            patch.entrou_coluna_em = new Date().toISOString()
          }
          await supabase.from('leads').update(patch).eq('id', lead.id)
          if (moveParaNoShow) {
            await supabase.from('acoes_sara').insert({
              lead_id: lead.id,
              tipo: 'movimentacao',
              conteudo: 'No Show automático: visita passou +2h sem ser marcada como realizada.',
              razao: 'no_show',
              sucesso: true,
              coluna_origem_id: lead.coluna_id,
              coluna_destino_id: noShowColunaId,
            })
            await supabase.from('eventos_timeline').insert({
              lead_id: lead.id,
              tipo: 'movido_coluna',
              descricao: 'Movido para "No Show" (visita não confirmada como realizada 2h após o horário).',
            })
          }
          count = 0
        } else if (
          !estaDevido(
            { ultimaInteracaoMs, ultimoFollowupMs, entrouColunaMs, intervaloBaseHoras: intervaloBase, count },
            agora
          )
        ) {
          continue
        }
        triggerLog = 'resgate_no_show'
        promptFollowup = promptPorTrigger('resgate_no_show', lead.familia!.nome_responsavel, count + 1)
      }
    } else if (trigger === 'followup_pos_visita') {
      // PÓS-VISITA — régua de 5 toques em 14 dias (D0/D3/D7/D10/D14), o vazamento nº 3
      // do ebook. O 1º toque (D0) sai assim que o lead entra em "Visita Realizada"
      // (comportamento de 02/09); os seguintes seguem o cronograma POS_VISITA_TOQUES_HORAS.
      // O índice do próximo toque = quantos toques de pós-visita já saíram NESTA entrada
      // na coluna (envio real OU alerta manual). Isso desacopla do followup_count — que
      // zera quando a família responde — e serve de dedup por toque.
      if (entrouColunaMs === 0) continue
      const { count: jaEnviados } = await supabase
        .from('followup_log')
        .select('id', { count: 'exact', head: true })
        .eq('lead_id', lead.id)
        .in('trigger', ['followup_pos_visita', 'followup_pos_visita_alerta'])
        .gte('criado_em', new Date(entrouColunaMs).toISOString())
      toquesPosVisita = jaEnviados ?? 0

      if (toquesPosVisita >= POS_VISITA_MAX_TOQUES) {
        await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
        resultados.push({ lead: lead.id, skip: 'pos_visita_esgotado' })
        continue
      }
      // A partir do 2º toque (índice >= 1), só cutuca se a família seguiu em SILÊNCIO
      // desde o último toque. Se respondeu, a conversa reativa (Sara/humano) assume; a
      // régua retoma sozinha se ela voltar a silenciar.
      if (toquesPosVisita >= 1 && respondeuAposFollowup(ultimaInteracaoMs, ultimoFollowupMs)) continue
      if (!estaDevidoPosVisita(entrouColunaMs, toquesPosVisita, agora)) continue

      promptFollowup = promptPosVisitaPorToque(lead.familia!.nome_responsavel, toquesPosVisita)
    } else if (trigger === 'resgate_no_show') {
      // NO-SHOW (2026-08-13): o gestor move o lead para a coluna "No Show" e o resgate
      // deve sair IMEDIATAMENTE nessa entrada — nada de esperar o intervalo da coluna.
      // Critério de "acabou de entrar": nenhum follow-up desde que entrou na coluna
      // (entrou_coluna_em é atualizado a cada movimentação). O 1º toque zera o contador
      // para o resgate começar do ângulo 1; os toques seguintes seguem o backoff normal.
      // Continua preso à janela 8h–20h Acre (guarda no topo do cron).
      const semToqueDesdeEntrada = entrouColunaMs > ultimoFollowupMs
      if (semToqueDesdeEntrada) {
        if (!lead.no_show_em || count !== 0) {
          await supabase
            .from('leads')
            .update({ no_show_em: lead.no_show_em ?? new Date().toISOString(), followup_count: 0 })
            .eq('id', lead.id)
          count = 0
          promptFollowup = promptPorTrigger('resgate_no_show', lead.familia!.nome_responsavel, count + 1)
        }
      } else {
        const devido = estaDevido(
          { ultimaInteracaoMs, ultimoFollowupMs, entrouColunaMs, intervaloBaseHoras: intervaloBase, count },
          agora
        )
        if (!devido) continue
      }
    } else if (trigger === 'recuperacao') {
      // REPESCAGEM — defer-aware (reengajamento agendado). A Sara pode ter combinado com a
      // família uma data para retomar (reativar_em):
      //   • data no FUTURO  → lead DORMENTE: nenhuma cutucada (anti-bloqueio). Como nunca é
      //     tocado, não incrementa nem esgota, então o sweep de "Perdidos por silêncio"
      //     (só mexe em followup_status='esgotado') também não o alcança.
      //   • data JÁ CHEGOU → UM toque caloroso de reengajamento_agendado. Depois dele
      //     limpamos reativar_em (abaixo) e o lead volta à cadência normal de recuperação.
      //   • sem data        → recuperação normal (backoff da coluna), como antes.
      const reativarMs = ms(lead.reativar_em)
      if (reativarMs > agora) {
        resultados.push({ lead: lead.id, skip: 'repescagem_dormente' })
        continue
      }
      if (reativacaoDevida(reativarMs, agora)) {
        triggerLog = 'reengajamento_agendado'
        promptFollowup = promptPorTrigger(
          'reengajamento_agendado',
          lead.familia!.nome_responsavel,
          1,
          lead.reativar_motivo
        )
      } else {
        const devido = estaDevido(
          { ultimaInteracaoMs, ultimoFollowupMs, entrouColunaMs, intervaloBaseHoras: intervaloBase, count },
          agora
        )
        if (!devido) continue
      }
    } else {
      const devido = estaDevido(
        { ultimaInteracaoMs, ultimoFollowupMs, entrouColunaMs, intervaloBaseHoras: intervaloBase, count },
        agora
      )
      if (!devido) continue
    }

    // Portão de envio (src/lib/envio): opt-out e janela ANTES de gastar a geração da
    // Sara. Opt-out encerra o follow-up do lead; janela só adia (próxima rodada).
    const canalSaida = await canalDeSaida(tel, lead.familia?.whatsapp_phone_number_id)
    const ctxEnvio = {
      origem: 'followup' as const,
      canal: canalSaida,
      telefone: tel,
      leadId: lead.id,
      familiaId: lead.familia_id,
    }
    const pre = await preChecarEnvio(ctxEnvio)
    if (!pre.ok) {
      if (pre.motivo === 'opt_out') {
        await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
      }
      resultados.push({ lead: lead.id, trigger, enviado: false, skip: `protecao_${pre.motivo}` })
      continue
    }

    let enviado = false
    let erro: string | null = null
    let texto = ''
    let viaAlerta = false
    let barradoPeloPortao: string | null = null
    try {
      const saraResult = await gerarRespostaSara(lead.id, undefined, undefined, promptFollowup, null, { prioridade: 'baixa', origem: 'followup' })
      toques++ // conta a geração no teto por execução (envio real OU alerta manual)
      texto = saraResult.resposta

      // JANELA DE 24h (modelo proativo):
      //   ABERTA  → texto livre pelo Cloud oficial.
      //   FECHADA → NÃO usamos template: a mensagem EXATA da Sara vira um ALERTA
      //             de envio manual (copiar e colar no WhatsApp Web) na tela /pendentes.
      // A checagem proativa evita gastar uma chamada à API sabidamente fora da janela;
      // o 131047 no catch abaixo é a rede de segurança se a nossa tabela estiver defasada.
      // WAHA não tem janela de 24h: lead que ENTROU pelo WAHA continua recebendo
      // follow-up PELO WAHA, texto livre, a qualquer hora (src/lib/canais roteia a
      // saída pelo mesmo canal do lead). No canal oficial (Cloud) respeitamos
      // a janela: fechada → alerta de envio manual (copiar e colar), SEM retomada
      // automática por template (decisão do gestor, 2026-09-22).
      // A janela só existe se a saída REAL for a Cloud (canalDeSaida, mesma regra do
      // envio; o envio aborta se o canal mudar até lá). Desde 21/10/2026 todas as contas Cloud estão inativas e
      // tudo sai pelo WAHA — família marcada 'cloud' ou sem canal não pode mais virar
      // "janela fechada" (gerava alerta manual + transbordo à toa).
      const aberta = canalSaida !== 'cloud' || (await janelaAberta(supabase, tel))
      if (!aberta) {
        if (texto.trim()) {
          await escalarFollowupJanelaFechada(supabase, {
            leadId: lead.id,
            telefone: tel,
            nome: lead.familia?.nome_responsavel ?? 'Família',
            texto,
            trigger: triggerLog,
            semTransbordo: trigger === 'followup_pos_visita',
          })
          viaAlerta = true
          triggerLog = `${triggerLog}_alerta`
        }
      } else {
        // Pelo handler central (src/lib/canais): o canal relido tem de ser o mesmo
        // que o portão e a janela avaliaram (canalEsperado), e a chave do toque
        // impede o mesmo balão de sair duas vezes se o cron repetir este lead.
        const baloes = dividirEmBaloes(texto)
        const num = (trigger === 'followup_pos_visita' ? toquesPosVisita : count) + 1
        for (let i = 0; i < baloes.length; i++) {
          let saida: Awaited<ReturnType<typeof enviarPeloCanal>> | null = null
          const r = await enviarProtegido(ctxEnvio, baloes[i], async () => {
            saida = await enviarPeloCanal({
              operacao: 'followup',
              telefone: tel,
              familiaId: lead.familia_id,
              leadId: lead.id,
              phoneId: lead.familia?.whatsapp_phone_number_id,
              texto: baloes[i],
              canalEsperado: canalSaida,
              chave: `followup:${lead.id}:${trigger}:${num}:${ultimaInteracaoMs ?? 0}:${i}`,
            })
            return saida.wid
          })
          if (r.status !== 'enviado') {
            // Nada saiu neste balão. No 1º balão o toque inteiro fica para a próxima
            // rodada (não conta tentativa); depois do 1º, o que saiu já vale como toque.
            if (i === 0) barradoPeloPortao = `${r.status}_${r.motivo}`
            break
          }
          const s = saida as Awaited<ReturnType<typeof enviarPeloCanal>> | null
          if (s?.duplicado) continue // este balão já saiu numa execução anterior
          await supabase.from('mensagens').insert({
            lead_id: lead.id,
            direcao: 'out_ia',
            conteudo: baloes[i],
            whatsapp_message_id: r.wid,
            ...(s ? carimboCanal(s) : {}),
          })
          if (i < baloes.length - 1) await sleep(900)
        }
        enviado = !barradoPeloPortao
      }
    } catch (e) {
      erro = e instanceof Error ? e.message : 'erro desconhecido'
      console.error(`Follow-up falhou para lead ${lead.id}:`, erro)

      // Rede de segurança: a janela fechou entre a checagem e o envio (ou a tabela
      // estava defasada). Cai no alerta manual em vez de falhar.
      if (ehErroJanela(e) && texto.trim()) {
        await escalarFollowupJanelaFechada(supabase, {
          leadId: lead.id,
          telefone: tel,
          nome: lead.familia?.nome_responsavel ?? 'Família',
          texto,
          trigger: triggerLog,
          semTransbordo: trigger === 'followup_pos_visita',
        })
        viaAlerta = true
        erro = null
        triggerLog = triggerLog.endsWith('_alerta') ? triggerLog : `${triggerLog}_alerta`
      }
    }

    // Barrado pelo portão (teto do dia, intervalo, repetição): não é falha nem
    // tentativa — não grava followup_log nem avança o timer. O ledger registra.
    if (barradoPeloPortao) {
      resultados.push({ lead: lead.id, trigger, enviado: false, skip: `protecao_${barradoPeloPortao}` })
      continue
    }

    await supabase.from('followup_log').insert({
      lead_id: lead.id,
      trigger: triggerLog,
      status: enviado ? 'enviado' : viaAlerta ? 'alerta_manual' : 'falhou',
      conteudo: enviado ? texto : viaAlerta ? `[alerta manual] ${texto}` : null,
      erro,
      followup_num: (trigger === 'followup_pos_visita' ? toquesPosVisita : count) + 1,
    })

    // Número inexistente no WhatsApp: para de tentar esse lead (ADR-005).
    // "no LID found" (WAHA) = o servidor do WhatsApp não acha conta para o número
    // (ex.: telefone salvo sem o 55). Repetia a cada 15 min, sempre primeiro da fila.
    if (!enviado && /"exists"\s*:\s*false|no LID found/.test(erro || '')) {
      await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
      resultados.push({ lead: lead.id, trigger, enviado: false, skip: 'numero_inexistente' })
      continue
    }

    // Avança o timer também quando gerou ALERTA manual (janela fechada) — senão
    // o cron recriaria um alerta a cada rodada para o mesmo lead.
    if (enviado || viaAlerta) {
      const novoCount = count + 1
      const update: Record<string, unknown> = {
        followup_count: novoCount,
        followup_sem_resposta: (lead.followup_sem_resposta ?? 0) + 1,
        ultimo_followup_em: new Date().toISOString(),
      }
      // Pós-visita esgota pelo cronograma (nº de toques nesta entrada); os demais, pelo
      // followup_max da coluna.
      const esgotou =
        trigger === 'followup_pos_visita'
          ? toquesPosVisita + 1 >= POS_VISITA_MAX_TOQUES
          : novoCount >= col.followup_max
      if (esgotou) update.followup_status = 'esgotado'
      // Convite de ligação: saiu 1x. Marca para não repetir; o lead NÃO volta a ser
      // perseguido por isso (o convite não conta no chase frio) e a Sara segue reativa.
      if (triggerLog === 'convite_ligacao' || triggerLog === 'convite_ligacao_alerta') {
        update.convite_ligacao_enviado_em = new Date().toISOString()
        update.followup_count = count
        update.followup_sem_resposta = lead.followup_sem_resposta ?? 0
        update.followup_status = lead.followup_status
      }
      // Reengajamento agendado: o toque combinado saiu. Limpa a data para não repetir e
      // deixa o lead retomar a cadência normal de recuperação (backoff) a partir daqui.
      if (triggerLog === 'reengajamento_agendado' || triggerLog === 'reengajamento_agendado_alerta') {
        update.reativar_em = null
        update.reativar_motivo = null
      }
      await supabase.from('leads').update(update).eq('id', lead.id)

      await supabase.from('acoes_sara').insert({
        lead_id: lead.id,
        tipo: 'followup',
        conteudo: texto,
        razao: `followup_${triggerLog}`,
        sucesso: enviado,
      })

      // Pacing anti-bloqueio só entre ENVIOS reais (o alerta manual não usa a API).
      if (enviado) {
        enviados++
        if (enviados < MAX_ENVIOS_POR_EXECUCAO) await sleep(jitterMs())
      }
    }

    resultados.push({ lead: lead.id, trigger, enviado, erro })
  }

  // AUDITORIA CMO 2026-07-29 — falha silenciosa.
  // O gateway (Evolution) ficou fora do ar e 100% dos follow-ups falharam por um
  // dia inteiro sem gerar UM alerta: o registrarAlerta só cobria erro na QUERY de
  // leads, nunca erro de ENVIO. Se houve tentativas e todas falharam, isso é o
  // gateway caído (instância desconectada ou erro interno), não azar. Avisa.
  const tentativas = resultados.filter((r) => r.trigger && !r.skip).length
  const falhas = resultados.filter((r) => r.erro).length
  if (tentativas >= 3 && falhas === tentativas) {
    await registrarAlerta(
      supabase,
      'cron/followup',
      `Follow-up com falha total: ${falhas} de ${tentativas} envios falharam nesta execução. ` +
        `Provável queda do gateway WhatsApp (instância desconectada). ` +
        `Primeiro erro: ${resultados.find((r) => r.erro)?.erro ?? 'desconhecido'}`
    )
  }

  // Encerra por silêncio: leads que esgotaram os follow-ups e ficaram N dias sem responder.
  let perdidosPorSilencio = 0
  try {
    // Só em horário comercial: fora dele a rodada existe apenas para o lembrete de
    // visita iminente e não deve mover leads para "Perdidos" de madrugada.
    if (!foraDoHorario) perdidosPorSilencio = await marcarPerdidosPorSilencio(supabase, agora)
  } catch (e) {
    console.error('Falha ao marcar perdidos por silêncio:', e)
    await registrarAlerta(supabase, 'cron/followup', e instanceof Error ? e.message : 'perdidos_por_silencio')
  }

  return {
    ok: true,
    hora_acre: horaAcre(agora),
    processados: resultados.length,
    enviados: resultados.filter((r) => r.enviado).length,
    perdidos_por_silencio: perdidosPorSilencio,
    resultados,
  }
}
