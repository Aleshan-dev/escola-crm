import { ACRE_SHIFT_MS } from '@/lib/disponibilidade'

// Regras PURAS do follow-up (sem banco) — o cron decide QUANDO agir com base nelas.

export type TriggerNome =
  | 'primeiro_contato'
  | 'confirmacao_visita'
  | 'followup_pos_visita'
  | 'recuperacao'
  | 'reengajamento'

export const HORA_MIN = 8
export const HORA_MAX = 20

/** Hora (0-23) no fuso de Rio Branco/Acre para um instante em ms. */
export function horaAcre(nowMs: number): number {
  return new Date(nowMs + ACRE_SHIFT_MS).getUTCHours()
}

/** Está dentro do horário comercial (8h–20h, Acre)? */
export function dentroHorarioComercial(nowMs: number): boolean {
  const h = horaAcre(nowMs)
  return h >= HORA_MIN && h < HORA_MAX
}

/** Mapeia a etapa do funil para o tipo de follow-up. */
export function triggerPorColuna(nome: string): TriggerNome {
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

/** Intervalo efetivo (ms) com backoff crescente por tentativa. */
export function intervaloEfetivoMs(intervaloBaseHoras: number, count: number): number {
  return intervaloBaseHoras * (count + 1) * 60 * 60 * 1000
}

export type EntradaElegibilidade = {
  ultimaInteracaoMs: number
  ultimoFollowupMs: number
  entrouColunaMs: number
  intervaloBaseHoras: number
  count: number
}

/** Um lead (não-confirmação-de-visita) está "vencido" para novo follow-up? */
export function estaDevido(e: EntradaElegibilidade, agoraMs: number): boolean {
  const referencia = Math.max(e.ultimaInteracaoMs, e.ultimoFollowupMs, e.entrouColunaMs)
  return referencia + intervaloEfetivoMs(e.intervaloBaseHoras, e.count) <= agoraMs
}

/** O lead respondeu depois do último follow-up? (reengajou -> zera contador) */
export function respondeuAposFollowup(ultimaInteracaoMs: number, ultimoFollowupMs: number): boolean {
  return ultimoFollowupMs > 0 && ultimaInteracaoMs > ultimoFollowupMs
}

/** A visita agendada é amanhã (no fuso de Acre)? — caso especial da confirmação. */
export function ehVisitaAmanha(dataVisitaMs: number, agoraMs: number): boolean {
  const wVisita = new Date(dataVisitaMs + ACRE_SHIFT_MS)
  const wAmanha = new Date(agoraMs + ACRE_SHIFT_MS + 24 * 60 * 60 * 1000)
  return (
    wVisita.getUTCFullYear() === wAmanha.getUTCFullYear() &&
    wVisita.getUTCMonth() === wAmanha.getUTCMonth() &&
    wVisita.getUTCDate() === wAmanha.getUTCDate()
  )
}

/** Dias de silêncio (após esgotar os follow-ups) para dar o lead como perdido. */
export const DIAS_SILENCIO_PERDIDO = 7

/**
 * O lead deve virar "Perdido" por silêncio?
 * Regra: já esgotou os follow-ups da etapa e passou N dias desde o último follow-up
 * sem resposta (qualquer resposta zera o contador e reativa o follow-up, então um lead
 * ainda "esgotado" é porque continuou sem responder).
 */
export function deveMarcarPerdidoPorSilencio(
  ultimoFollowupMs: number,
  agoraMs: number,
  diasSilencio: number = DIAS_SILENCIO_PERDIDO
): boolean {
  if (ultimoFollowupMs <= 0) return false
  return agoraMs - ultimoFollowupMs >= diasSilencio * 24 * 60 * 60 * 1000
}

/** Texto do prompt que orienta a Sara conforme o gatilho. */
export function promptPorTrigger(trigger: TriggerNome, nome: string, tentativa: number): string {
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
