import { describe, it, expect } from 'vitest'
import { gerarSlots, acreWallToUtc, labelAcre, dentroDaJanelaVisita, type HorarioVisita } from './disponibilidade'

const DIAS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
]
// Nome do dia da semana (Acre) para uma data UTC de "parede".
function nomeDia(y: number, mo: number, d: number): string {
  return DIAS[new Date(Date.UTC(y, mo, d)).getUTCDay()]
}

// AUDITORIA CMO 2026-07-29 — regressão da conversa da Gislainy.
// Às 10h03 a Sara ofereceu visita para 12:30 e 13:30 do MESMO dia (default de
// antecedenciaMin=120) e as duas opções morreram juntas num "não consigo hoje".
// O sara.ts passa a chamar com antecedenciaMin=720 e maxPorDia=1.
describe('slots com os parâmetros que o sara.ts usa', () => {
  const PARAMS = { quantidade: 2, antecedenciaMin: 720, maxPorDia: 1 }
  // Janela de visita em todos os dias da semana, 08:00 às 17:00.
  const horarios: HorarioVisita[] = DIAS.map((d) => ({
    dia_semana: d,
    hora_inicio: '08:00',
    hora_fim: '17:00',
  }))
  // Quarta, 29/07/2026, 10:03 em Acre — o instante exato da conversa.
  const agora = acreWallToUtc(2026, 6, 29, 10, 3).getTime()

  it('NÃO oferece mais nenhum horário no mesmo dia', () => {
    const slots = gerarSlots(horarios, [], agora, PARAMS)
    expect(slots).toHaveLength(2)
    for (const s of slots) {
      expect(s.label, `slot ${s.label} caiu no mesmo dia`).not.toContain('29/07')
    }
  })

  it('distribui as duas opções em DIAS diferentes', () => {
    const slots = gerarSlots(horarios, [], agora, PARAMS)
    const dias = slots.map((s) => s.label.match(/\d{2}\/\d{2}/)?.[0])
    expect(dias[0]).not.toBe(dias[1])
  })

  it('a primeira opção é no dia seguinte (não esfria o lead)', () => {
    const slots = gerarSlots(horarios, [], agora, PARAMS)
    expect(slots[0].label).toContain('30/07')
  })

  it('com o default antigo, o bug se reproduz (mesmo dia, horários seguidos)', () => {
    const antigo = gerarSlots(horarios, [], agora, { quantidade: 2 })
    expect(antigo[0].label).toContain('29/07')
    expect(antigo[1].label).toContain('29/07')
  })
})

describe('fuso de Acre', () => {
  it('converte parede de Acre para UTC (UTC-5)', () => {
    // 09:00 em Acre em 2026-07-02 = 14:00 UTC
    expect(acreWallToUtc(2026, 6, 2, 9, 0).toISOString()).toBe('2026-07-02T14:00:00.000Z')
  })

  it('rotula um instante UTC no horário de Acre', () => {
    const utc = new Date('2026-07-02T14:00:00.000Z')
    const label = labelAcre(utc)
    expect(label).toContain('02/07')
    expect(label).toContain('às 09:00')
  })
})

describe('gerarSlots', () => {
  const agora = acreWallToUtc(2026, 6, 1, 7, 0).getTime() // 2026-07-01 07:00 Acre
  const janela: HorarioVisita[] = [
    { dia_semana: nomeDia(2026, 6, 1), hora_inicio: '09:00:00', hora_fim: '11:00:00' },
  ]

  it('retorna os próximos 2 horários livres dentro da janela', () => {
    const slots = gerarSlots(janela, [], agora, { quantidade: 2, antecedenciaMin: 120 })
    expect(slots).toHaveLength(2)
    expect(slots[0].data_hora).toBe(acreWallToUtc(2026, 6, 1, 9, 0).toISOString())
    expect(slots[1].data_hora).toBe(acreWallToUtc(2026, 6, 1, 10, 0).toISOString())
  })

  it('pula horários já ocupados', () => {
    const ocupado = [acreWallToUtc(2026, 6, 1, 9, 0).getTime()] // 09:00 ocupado
    const slots = gerarSlots(janela, ocupado, agora, { quantidade: 1, antecedenciaMin: 120 })
    expect(slots[0].data_hora).toBe(acreWallToUtc(2026, 6, 1, 10, 0).toISOString())
  })

  it('respeita a antecedência mínima (não oferece horário perto demais)', () => {
    // agora 08:30 Acre, antecedência 120min -> limiteInf 10:30 -> só o 10:00? não, 10:00<10:30
    const agoraTarde = acreWallToUtc(2026, 6, 1, 8, 30).getTime()
    const slots = gerarSlots(janela, [], agoraTarde, { quantidade: 2, antecedenciaMin: 120 })
    // 09:00 e 10:00 de hoje ficam antes de 10:30 -> excluídos; cai para a próxima semana
    expect(slots[0].data_hora).not.toBe(acreWallToUtc(2026, 6, 1, 9, 0).toISOString())
  })

  it('retorna vazio quando não há janelas configuradas', () => {
    expect(gerarSlots([], [], agora)).toEqual([])
  })
})

describe('dentroDaJanelaVisita (blindagem de fuso)', () => {
  // Grade real: terça-feira 07:30–17:00 (27/10/2026 é terça).
  const dia = nomeDia(2026, 9, 27)
  const grade: HorarioVisita[] = [{ dia_semana: dia, hora_inicio: '07:30:00', hora_fim: '17:00:00' }]

  it('aceita um horário dentro da grade (08:00 Acre = 13:00Z)', () => {
    expect(dentroDaJanelaVisita(acreWallToUtc(2026, 9, 27, 8, 0).toISOString(), grade)).toBe(true)
  })

  it('rejeita o bug de fuso: hora de parede carimbada como UTC (08:00Z = 03:00 Acre)', () => {
    expect(dentroDaJanelaVisita('2026-10-27T08:00:00.000Z', grade)).toBe(false)
  })

  it('rejeita um dia sem janela ativa', () => {
    expect(dentroDaJanelaVisita(acreWallToUtc(2026, 9, 28, 10, 0).toISOString(), grade)).toBe(false)
  })
})
