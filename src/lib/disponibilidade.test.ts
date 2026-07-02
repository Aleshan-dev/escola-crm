import { describe, it, expect } from 'vitest'
import { gerarSlots, acreWallToUtc, labelAcre, type HorarioVisita } from './disponibilidade'

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
