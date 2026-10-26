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

/**
 * A hora de PAREDE (Acre) deste instante cai dentro de alguma janela de visita ativa?
 * Blindagem de fuso (2026-10-26): a Sara às vezes devolve `data_hora` com a hora de
 * parede carimbada como UTC (ex.: "08:00Z" para uma visita de 08:00 Acre, que de fato
 * é 13:00Z), gravando a visita 5h cedo — fora da grade e, muitas vezes, fora da faixa
 * visível da agenda. Quem booka usa isto para ALERTAR o gestor quando o horário cai
 * fora da grade (não reescrevemos: a família recebeu uma hora específica).
 */
export function dentroDaJanelaVisita(iso: string, horarios: HorarioVisita[]): boolean {
  const ms = new Date(iso).getTime()
  if (isNaN(ms)) return false
  const w = new Date(ms + ACRE_SHIFT_MS) // parede de Acre via getUTC*
  const dia = DIAS_PT[w.getUTCDay()]
  const minutos = w.getUTCHours() * 60 + w.getUTCMinutes()
  return horarios.some((h) => {
    if (h.dia_semana !== dia || !h.hora_inicio || !h.hora_fim) return false
    const ini = parseHora(h.hora_inicio)
    const fim = parseHora(h.hora_fim)
    return minutos >= ini.hora * 60 + ini.min && minutos < fim.hora * 60 + fim.min
  })
}

export type OpcoesSlot = {
  quantidade?: number
  duracaoMin?: number
  horizonteDias?: number
  antecedenciaMin?: number
  maxPorDia?: number // quando definido, limita e DISTRIBUI os horários por dia (manhã→tarde)
}

// Seleciona até n itens distribuídos ao longo do array (inclui o primeiro e o último).
function distribuir<T>(arr: T[], n: number): T[] {
  if (n >= arr.length || n <= 0) return arr
  if (n === 1) return [arr[0]]
  const idxs = new Set<number>()
  for (let k = 0; k < n; k++) idxs.add(Math.round((k * (arr.length - 1)) / (n - 1)))
  return Array.from(idxs).sort((a, b) => a - b).map((i) => arr[i])
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

    // Coleta TODOS os horários livres do dia (em ordem cronológica).
    const doDia: SlotDisponivel[] = []
    for (const j of janelas) {
      const ini = parseHora(j.hora_inicio!)
      const fim = parseHora(j.hora_fim!)
      const fimMin = fim.hora * 60 + fim.min
      let cursor = ini.hora * 60 + ini.min
      while (cursor + duracaoMin <= fimMin) {
        const h = Math.floor(cursor / 60)
        const m = cursor % 60
        const utc = acreWallToUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m)
        const ms = utc.getTime()
        if (ms >= limiteInf && !conflita(ms)) {
          doDia.push({ data_hora: utc.toISOString(), label: labelAcre(utc) })
        }
        cursor += duracaoMin
      }
    }

    // Sem maxPorDia: comportamento antigo (pega em ordem). Com maxPorDia: distribui (manhã→tarde).
    const escolhidos = opts?.maxPorDia ? distribuir(doDia, opts.maxPorDia) : doDia
    for (const s of escolhidos) {
      if (slots.length >= quantidade) break
      slots.push(s)
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
