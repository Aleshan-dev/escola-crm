import { describe, it, expect } from 'vitest'
import { acreWallToUtc } from './disponibilidade'
import {
  horaAcre,
  dentroHorarioComercial,
  triggerPorColuna,
  intervaloEfetivoMs,
  estaDevido,
  respondeuAposFollowup,
  ehVisitaAmanha,
  deveMarcarPerdidoPorSilencio,
  DIAS_SILENCIO_PERDIDO,
} from './followup-regras'

const H = 60 * 60 * 1000

describe('horário comercial (Acre)', () => {
  it('calcula a hora no fuso de Acre', () => {
    expect(horaAcre(acreWallToUtc(2026, 6, 1, 8, 0).getTime())).toBe(8)
    expect(horaAcre(acreWallToUtc(2026, 6, 1, 19, 30).getTime())).toBe(19)
  })
  it('respeita a janela 8h–20h', () => {
    expect(dentroHorarioComercial(acreWallToUtc(2026, 6, 1, 8, 0).getTime())).toBe(true)
    expect(dentroHorarioComercial(acreWallToUtc(2026, 6, 1, 19, 59).getTime())).toBe(true)
    expect(dentroHorarioComercial(acreWallToUtc(2026, 6, 1, 7, 30).getTime())).toBe(false)
    expect(dentroHorarioComercial(acreWallToUtc(2026, 6, 1, 20, 0).getTime())).toBe(false)
  })
})

describe('triggerPorColuna', () => {
  it('mapeia etapas conhecidas', () => {
    expect(triggerPorColuna('Capturados')).toBe('primeiro_contato')
    expect(triggerPorColuna('Visita Agendada')).toBe('confirmacao_visita')
    expect(triggerPorColuna('Visita Realizada')).toBe('followup_pos_visita')
    expect(triggerPorColuna('Repescagem')).toBe('recuperacao')
  })
  it('usa reengajamento como padrão (ex.: Em Atendimento, No Show)', () => {
    expect(triggerPorColuna('Em Atendimento')).toBe('reengajamento')
    expect(triggerPorColuna('No Show')).toBe('reengajamento')
  })
})

describe('backoff', () => {
  it('cresce a cada tentativa', () => {
    expect(intervaloEfetivoMs(24, 0)).toBe(24 * H)
    expect(intervaloEfetivoMs(24, 1)).toBe(48 * H)
    expect(intervaloEfetivoMs(48, 2)).toBe(144 * H)
  })
})

describe('estaDevido', () => {
  const agora = Date.now()
  it('está vencido quando passou o intervalo', () => {
    expect(
      estaDevido(
        { ultimaInteracaoMs: agora - 50 * H, ultimoFollowupMs: 0, entrouColunaMs: agora - 50 * H, intervaloBaseHoras: 48, count: 0 },
        agora
      )
    ).toBe(true)
  })
  it('não está vencido antes do intervalo', () => {
    expect(
      estaDevido(
        { ultimaInteracaoMs: agora - 40 * H, ultimoFollowupMs: 0, entrouColunaMs: agora - 40 * H, intervaloBaseHoras: 48, count: 0 },
        agora
      )
    ).toBe(false)
  })
  it('o backoff adia a próxima tentativa', () => {
    // mesma referência (-50h) mas count=1 -> intervalo 96h -> ainda não vencido
    expect(
      estaDevido(
        { ultimaInteracaoMs: agora - 50 * H, ultimoFollowupMs: agora - 50 * H, entrouColunaMs: agora - 50 * H, intervaloBaseHoras: 48, count: 1 },
        agora
      )
    ).toBe(false)
  })
})

describe('respondeuAposFollowup', () => {
  const agora = Date.now()
  it('detecta resposta após o follow-up', () => {
    expect(respondeuAposFollowup(agora, agora - 1 * H)).toBe(true)
  })
  it('não dispara se não respondeu depois', () => {
    expect(respondeuAposFollowup(agora - 2 * H, agora - 1 * H)).toBe(false)
  })
  it('ignora quando nunca houve follow-up', () => {
    expect(respondeuAposFollowup(agora, 0)).toBe(false)
  })
})

describe('deveMarcarPerdidoPorSilencio', () => {
  const agora = Date.now()
  const D = 24 * H
  it('marca perdido após o prazo de silêncio', () => {
    expect(deveMarcarPerdidoPorSilencio(agora - (DIAS_SILENCIO_PERDIDO + 1) * D, agora)).toBe(true)
  })
  it('não marca antes do prazo', () => {
    expect(deveMarcarPerdidoPorSilencio(agora - (DIAS_SILENCIO_PERDIDO - 1) * D, agora)).toBe(false)
  })
  it('marca exatamente no limite do prazo', () => {
    expect(deveMarcarPerdidoPorSilencio(agora - DIAS_SILENCIO_PERDIDO * D, agora)).toBe(true)
  })
  it('ignora quando nunca houve follow-up', () => {
    expect(deveMarcarPerdidoPorSilencio(0, agora)).toBe(false)
  })
})

describe('ehVisitaAmanha', () => {
  const agora = acreWallToUtc(2026, 6, 2, 9, 0).getTime() // 2026-07-02 09:00 Acre
  it('reconhece visita marcada para amanhã', () => {
    const visita = acreWallToUtc(2026, 6, 3, 10, 0).getTime() // 2026-07-03
    expect(ehVisitaAmanha(visita, agora)).toBe(true)
  })
  it('rejeita visita que não é amanhã', () => {
    const hoje = acreWallToUtc(2026, 6, 2, 15, 0).getTime()
    const depois = acreWallToUtc(2026, 6, 4, 10, 0).getTime()
    expect(ehVisitaAmanha(hoje, agora)).toBe(false)
    expect(ehVisitaAmanha(depois, agora)).toBe(false)
  })
})
