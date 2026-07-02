import { createServerAdminClient } from '@/lib/supabase-server'

// Rio Branco / Acre = UTC-5 o ano todo (não observa horário de verão).
export const ACRE_SHIFT_MS = -5 * 60 * 60 * 1000
const DIAS_PT = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
]

export type SlotDisponivel = {
  data_hora: string // instante UTC em ISO (para gravar em tarefas.data_hora)
  label: string // rótulo em horário de Acre, ex: "quinta-feira, 02/07 às 09:00"
}

export type HorarioVisita = {
  dia_semana: string
  hora_inicio: string | null
  hora_fim: string | null
}

function parseHora(h: string): { hora: number; min: number } {
  const [hh, mm] = h.split(':')
  return { hora: parseInt(hh, 10), min: parseInt(mm || '0', 10) }
}

// Componentes de "parede" em Acre -> instante UTC real.
export function acreWallToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo, d, h, mi) - ACRE_SHIFT_MS)
}

// Instante UTC -> rótulo legível em horário de Acre.
export function labelAcre(utc: Date): string {
  const w = new Date(utc.getTime() + ACRE_SHIFT_MS) // lê a parede de Acre via getUTC*
  const diaSemana = DIAS_PT[w.getUTCDay()].toLowerCase()
  const dd = String(w.getUTCDate()).padStart(2, '0')
  const mm = String(w.getUTCMonth() + 1).padStart(2, '0')
  const hh = String(w.getUTCHours()).padStart(2, '0')
  const min = String(w.getUTCMinutes()).padStart(2, '0')
  return `${diaSemana}, ${dd}/${mm} às ${hh}:${min}`
}

export type OpcoesSlot = {
  quantidade?: number
  duracaoMin?: number
  horizonteDias?: number
  antecedenciaMin?: number
}

/**
 * Lógica PURA (sem banco, testável): dado o cadastro de horários, os instantes
 * já ocupados e o "agora", devolve os próximos slots de visita livres.
 */
export function gerarSlots(
  horarios: HorarioVisita[],
  ocupadosMs: number[],
  agoraMs: number,
  opts?: OpcoesSlot
): SlotDisponivel[] {
  const quantidade = opts?.quantidade ?? 2
  const duracaoMin = opts?.duracaoMin ?? 60
  const horizonteDias = opts?.horizonteDias ?? 21
  const antecedenciaMin = opts?.antecedenciaMin ?? 120

  if (horarios.length === 0) return []

  const limiteInf = agoraMs + antecedenciaMin * 60 * 1000
  const durMs = duracaoMin * 60 * 1000

  const conflita = (inicioMs: number): boolean =>
    ocupadosMs.some((o) => o < inicioMs + durMs && o + durMs > inicioMs)

  const slots: SlotDisponivel[] = []
  const hojeAcre = new Date(agoraMs + ACRE_SHIFT_MS) // parede de Acre

  for (let i = 0; i < horizonteDias && slots.length < quantidade; i++) {
    const base = new Date(
      Date.UTC(hojeAcre.getUTCFullYear(), hojeAcre.getUTCMonth(), hojeAcre.getUTCDate() + i)
    )
    const nomeDia = DIAS_PT[base.getUTCDay()]
    const janelas = horarios.filter((h) => h.dia_semana === nomeDia && h.hora_inicio && h.hora_fim)

    for (const j of janelas) {
      if (slots.length >= quantidade) break
      const ini = parseHora(j.hora_inicio!)
      const fim = parseHora(j.hora_fim!)
      const fimMin = fim.hora * 60 + fim.min
      let cursor = ini.hora * 60 + ini.min
      while (cursor + duracaoMin <= fimMin && slots.length < quantidade) {
        const h = Math.floor(cursor / 60)
        const m = cursor % 60
        const utc = acreWallToUtc(
          base.getUTCFullYear(),
          base.getUTCMonth(),
          base.getUTCDate(),
          h,
          m
        )
        const ms = utc.getTime()
        if (ms >= limiteInf && !conflita(ms)) {
          slots.push({ data_hora: utc.toISOString(), label: labelAcre(utc) })
        }
        cursor += duracaoMin
      }
    }
  }

  return slots
}

/**
 * Wrapper com banco: busca `horarios_visita` (ativos) e as `tarefas` ocupadas
 * (inclui eventos do Google já sincronizados) e delega o cálculo à `gerarSlots`.
 */
export async function calcularSlotsDisponiveis(
  supabase: ReturnType<typeof createServerAdminClient>,
  opts?: OpcoesSlot
): Promise<SlotDisponivel[]> {
  const duracaoMin = opts?.duracaoMin ?? 60

  const { data: horariosRaw } = await supabase
    .from('horarios_visita')
    .select('dia_semana, hora_inicio, hora_fim')
    .eq('ativo', true)
  const horarios = (horariosRaw as HorarioVisita[] | null) || []
  if (horarios.length === 0) return []

  const agora = Date.now()
  const { data: tarefasRaw } = await supabase
    .from('tarefas')
    .select('data_hora, status')
    .gte('data_hora', new Date(agora - duracaoMin * 60 * 1000).toISOString())
    .neq('status', 'cancelada')
  const ocupados = ((tarefasRaw as { data_hora: string; status: string }[] | null) || []).map((t) =>
    new Date(t.data_hora).getTime()
  )

  return gerarSlots(horarios, ocupados, agora, opts)
}
