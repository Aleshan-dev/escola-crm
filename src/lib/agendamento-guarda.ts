// Guardas do agendamento de visita pela Sara (lógica pura, testada).
//
// CASO AMANDA (22/11/2026): a Sara OFERECEU "terça 24/11 às 09:30 ou quarta 25/11 às
// 14:00 — qual fica melhor?" e o servidor já gravou a visita e avisou a Direção, antes
// de a família escolher. Causas:
//  1. a rede de segurança "disse que agendou mas não preencheu a ação" achava a palavra
//     "agend…" em "tenho duas opções de horário na AGENDA" e casava o 1º horário citado;
//  2. no turno seguinte o slot_id que o modelo repetiu ("v1") apontava para OUTRO horário
//     (a lista é recalculada a cada turno e o 09:30 já estava ocupado pela própria visita)
//     → a visita foi para 07:30 enquanto a Sara dizia 09:30.

export type SlotOfertado = { id: string; data_hora: string }

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Rio_Branco',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** Dia/mês e hora de PAREDE de Acre de um instante. */
export function paredeAcre(iso: string): { dd: string; mm: string; hh: string; mi: string } | null {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const p = FMT.formatToParts(d)
  const get = (tp: string) => p.find((x) => x.type === tp)?.value ?? ''
  return { dd: get('day'), mm: get('month'), hh: get('hour'), mi: get('minute') }
}

/** Horários "HH:MM" / "HHhMM" citados no texto, normalizados como "HH:MM". */
export function horasNoTexto(texto: string): Set<string> {
  const out = new Set<string>()
  for (const m of (texto || '').matchAll(/\b(\d{1,2})\s*(?::|h)\s*(\d{2})\b/gi)) {
    const h = Number(m[1])
    if (h <= 23) out.add(`${String(h).padStart(2, '0')}:${m[2]}`)
  }
  return out
}

/** O texto cita este instante (dia DD/MM + hora de Acre)? `exigirData=false` aceita só a hora. */
export function textoCitaInstante(texto: string, iso: string, exigirData = true): boolean {
  const w = paredeAcre(iso)
  if (!w) return false
  const t = (texto || '').toLowerCase()
  const horaOk = horasNoTexto(t).has(`${w.hh}:${w.mi}`)
  if (!exigirData) return horaOk
  const dataOk = t.includes(`${w.dd}/${w.mm}`) || t.includes(`${Number(w.dd)}/${Number(w.mm)}`)
  return dataOk && horaOk
}

/** Slots ofertados cujo dia+hora aparecem no texto. */
export function slotsCitados(texto: string, slots: SlotOfertado[] | null | undefined): string[] {
  if (!texto || !slots?.length) return []
  return slots.filter((s) => textoCitaInstante(texto, s.data_hora)).map((s) => s.id)
}

/** A fala é uma OFERTA de horários (dois ou mais horários + pergunta), não uma confirmação. */
export function ehOfertaDeHorarios(texto: string): boolean {
  return horasNoTexto(texto).size >= 2 && /\?/.test(texto || '')
}

/**
 * A Sara AFIRMOU que marcou/remarcou? Só verbos de ação concluída ("agendei", "deixei
 * agendada", "já está agendado", "remarquei"), com horário no texto — e nunca numa oferta.
 * NÃO conta "agenda" (substantivo), "agendar" (convite) nem "confirmado para" (que também é
 * confirmação de PRESENÇA de uma visita que já existe).
 */
export function afirmaAgendamento(texto: string): boolean {
  const t = texto || ''
  if (ehOfertaDeHorarios(t) || horasNoTexto(t).size === 0) return false
  return (
    /\b(agendei|reagendei|remarquei|marquei)\b/i.test(t) ||
    /\bajustei\s+o?\s*hor[áa]rio/i.test(t) ||
    /\bdeixei\s+(?:\S+\s+){0,3}?(agendad|marcad|reservad|remarcad|reagendad)/i.test(t) ||
    /\b(?:est[áa]|ficou|fica)\s+(?:\S+\s+){0,2}?(agendad|remarcad|reagendad)/i.test(t)
  )
}

/** Casa o dia+hora AFIRMADOS com UM único slot ofertado neste turno (sem ambiguidade). */
export function casarSlotAfirmado(texto: string, slots: SlotOfertado[] | null | undefined): string | null {
  const c = slotsCitados(texto, slots)
  return c.length === 1 ? c[0] : null
}

/**
 * Confere o slot que o modelo devolveu contra o horário que ele DISSE à família.
 * - texto sem horário → confia no slot;
 * - a hora do slot aparece no texto → confia;
 * - senão, se o texto cita exatamente um slot ofertado → usa esse;
 * - senão → null (não grava; quem chama decide o que fazer).
 */
export function conferirSlotComTexto(
  slotId: string,
  texto: string,
  slots: SlotOfertado[] | null | undefined,
): string | null {
  const slot = slots?.find((s) => s.id === slotId)
  if (!slot) return null
  if (horasNoTexto(texto).size === 0) return slotId
  if (textoCitaInstante(texto, slot.data_hora, false)) return slotId
  return casarSlotAfirmado(texto, slots)
}
