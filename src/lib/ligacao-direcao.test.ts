import { describe, expect, it } from 'vitest'
import { duracaoMs } from '@/lib/google-calendar'
import { promptConviteLigacao, validarHorarioLigacao } from '@/lib/ligacao-direcao'

// Quinta-feira, 26/11/2026, 15:00 em Rio Branco (UTC-5) = 20:00 UTC.
const AGORA = Date.UTC(2026, 10, 26, 20, 0)

describe('validarHorarioLigacao', () => {
  it('aceita dia útil no horário e converte a parede de Acre para UTC', () => {
    const r = validarHorarioLigacao('2026-11-27', '10:00', AGORA)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.utc.toISOString()).toBe('2026-11-27T15:00:00.000Z')
  })

  it('aceita a borda 08:00 e 17:45', () => {
    expect(validarHorarioLigacao('2026-11-27', '08:00', AGORA).ok).toBe(true)
    expect(validarHorarioLigacao('2026-11-27', '17:45', AGORA).ok).toBe(true)
  })

  it('recusa fora do horário', () => {
    expect(validarHorarioLigacao('2026-11-27', '07:30', AGORA)).toEqual({ ok: false, motivo: 'fora_do_horario' })
    expect(validarHorarioLigacao('2026-11-27', '18:00', AGORA)).toEqual({ ok: false, motivo: 'fora_do_horario' })
  })

  it('recusa sábado e domingo', () => {
    expect(validarHorarioLigacao('2026-11-28', '10:00', AGORA)).toEqual({ ok: false, motivo: 'fim_de_semana' })
    expect(validarHorarioLigacao('2026-11-29', '10:00', AGORA)).toEqual({ ok: false, motivo: 'fim_de_semana' })
  })

  it('recusa passado e menos de 1h de antecedência', () => {
    expect(validarHorarioLigacao('2026-11-26', '15:30', AGORA)).toEqual({ ok: false, motivo: 'passado' })
    expect(validarHorarioLigacao('2026-11-25', '10:00', AGORA)).toEqual({ ok: false, motivo: 'passado' })
    expect(validarHorarioLigacao('2026-11-26', '16:30', AGORA).ok).toBe(true)
  })

  it('recusa dia fechado no calendário escolar', () => {
    const fechados = new Set(['2026-12-01'])
    expect(validarHorarioLigacao('2026-12-01', '14:00', AGORA, fechados)).toEqual({ ok: false, motivo: 'dia_fechado' })
  })

  it('recusa formato e data inexistente', () => {
    expect(validarHorarioLigacao('27/11/2026', '10:00', AGORA)).toEqual({ ok: false, motivo: 'formato' })
    expect(validarHorarioLigacao('2026-11-31', '10:00', AGORA)).toEqual({ ok: false, motivo: 'formato' })
    expect(validarHorarioLigacao('2026-11-27', '10h', AGORA)).toEqual({ ok: false, motivo: 'formato' })
  })
})

describe('duracaoMs (Google Agenda)', () => {
  it('usa a duração da tarefa e cai para 1h quando nula', () => {
    expect(duracaoMs(15)).toBe(15 * 60 * 1000)
    expect(duracaoMs(null)).toBe(60 * 60 * 1000)
    expect(duracaoMs(undefined)).toBe(60 * 60 * 1000)
  })
})

describe('promptConviteLigacao', () => {
  it('pede o melhor horário e proíbe preço/desconto', () => {
    const p = promptConviteLigacao('Cris')
    expect(p).toContain('Cris')
    expect(p).toContain('15 minutinhos')
    expect(p).toMatch(/melhor dia e horário/)
    expect(p).toMatch(/NÃO cite valores, descontos/)
  })
})
