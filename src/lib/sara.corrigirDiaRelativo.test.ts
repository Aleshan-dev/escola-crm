import { describe, it, expect } from 'vitest'
import { corrigirDiaRelativo } from './sara'

// "Parede de Acre" = Date lido via getUTC* (como o sara.ts monta _acreNow).
// Hoje = quarta-feira, 04/11/2026; amanhã = quinta-feira, 05/11/2026.
const HOJE_ACRE = new Date(Date.UTC(2026, 10, 4, 9, 0)) // 04/11/2026

describe('corrigirDiaRelativo — conserta o atropelo de data da Sara', () => {
  it('troca "hoje" por "amanhã" quando a data é de amanhã (caso Cris 04/11)', () => {
    const r = corrigirDiaRelativo(
      'Temos um horário disponível hoje, quinta-feira, 05/11, às 08:30.',
      HOJE_ACRE
    )
    expect(r).toBe('Temos um horário disponível amanhã, quinta-feira, 05/11, às 08:30.')
  })

  it('mantém "hoje" quando a data é realmente hoje', () => {
    const r = corrigirDiaRelativo('confirmado para hoje, quarta-feira, 04/11, às 14:30', HOJE_ACRE)
    expect(r).toBe('confirmado para hoje, quarta-feira, 04/11, às 14:30')
  })

  it('remove a palavra relativa quando a data não é nem hoje nem amanhã', () => {
    const r = corrigirDiaRelativo('te espero hoje, 12/11, às 09:00', HOJE_ACRE)
    expect(r).toBe('te espero 12/11, às 09:00')
  })

  it('corrige também o dia da semana errado', () => {
    const r = corrigirDiaRelativo('amanhã, segunda-feira, 05/11 às 08:30', HOJE_ACRE)
    expect(r).toBe('amanhã, quinta-feira, 05/11 às 08:30')
  })

  it('não mexe em "hoje" sem data colada', () => {
    expect(corrigirDiaRelativo('estou te esperando hoje à tarde', HOJE_ACRE)).toBe(
      'estou te esperando hoje à tarde'
    )
  })

  it('texto vazio volta vazio', () => {
    expect(corrigirDiaRelativo('', HOJE_ACRE)).toBe('')
  })
})
