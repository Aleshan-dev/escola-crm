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
  promptPorTrigger,
  anguloPorTentativa,
  estaDevidoPosVisita,
  promptPosVisitaPorToque,
  POS_VISITA_TOQUES_HORAS,
  POS_VISITA_MAX_TOQUES,
  type TriggerNome,
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
    // DRIFT FIX 2026-08-13 — "No Show" é a coluna dedicada do lead que faltou;
    // precisa disparar o resgate, NÃO o reengajamento genérico.
    expect(triggerPorColuna('No Show')).toBe('resgate_no_show')
  })
  it('usa reengajamento como padrão (ex.: Em Atendimento)', () => {
    expect(triggerPorColuna('Em Atendimento')).toBe('reengajamento')
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

// AUDITORIA CMO 2026-07-29 — o prompt de follow-up era fonte rastreada de
// cópia literal (travessão e frase pronta). Estes testes travam a regressão.
describe('promptPorTrigger', () => {
  const TRIGGERS: TriggerNome[] = [
    'primeiro_contato',
    'confirmacao_visita',
    'followup_pos_visita',
    'recuperacao',
    'reengajamento',
    'lembrete_dia',
    'resgate_no_show',
  ]

  it('nunca contém travessão em nenhum gatilho ou tentativa', () => {
    for (const t of TRIGGERS) {
      for (let n = 1; n <= 5; n++) {
        expect(promptPorTrigger(t, 'Larissa', n), `${t} tentativa ${n}`).not.toMatch(/[—–]/)
      }
    }
  })

  it('nunca entrega frase pronta entre aspas para a Sara copiar', () => {
    for (const t of TRIGGERS) {
      const texto = promptPorTrigger(t, 'Larissa', 1)
      expect(texto, t).not.toMatch(/"[^"]{15,}"/)
    }
  })

  it('sempre reforça a forma e usa o nome da família', () => {
    for (const t of TRIGGERS) {
      const texto = promptPorTrigger(t, 'Larissa', 1)
      expect(texto, t).toContain('Larissa')
      expect(texto, t).toContain('Nunca use travessão')
      expect(texto, t).toContain('Datas sempre absolutas')
    }
  })

  it('primeiro contato foca em nome e idade e NÃO oferece visita', () => {
    const texto = promptPorTrigger('primeiro_contato', 'Larissa', 1)
    expect(texto).toContain('nome e a idade da criança')
    expect(texto).toContain('NÃO ofereça visita')
  })

  it('reengajamento condiciona a oferta de horário a já ter nome e idade', () => {
    const texto = promptPorTrigger('reengajamento', 'Larissa', 1)
    expect(texto).toContain('Só ofereça horários se você já souber o nome e a idade')
    expect(texto).toContain('NUNCA invente escassez')
  })

  // AUDITORIA CMO 2026-10-29 — o pós-visita (D0) deixou de empilhar vaga + âncora de
  // preço num toque só. Faz UM movimento (reconhecer + abrir a objeção); o preço se
  // trata quando a objeção aparece.
  it('pós-visita (D0) abre a objeção sem empilhar vaga nem preço', () => {
    const texto = promptPorTrigger('followup_pos_visita', 'Larissa', 1)
    expect(texto).toContain('NÃO empilhe proposta de vaga nem valores')
    expect(texto).not.toContain('ANCORE')
  })

  it('a primeira tentativa não leva texto de reforço', () => {
    const texto = promptPorTrigger('reengajamento', 'Larissa', 1)
    expect(texto).not.toContain('reforço')
  })

  it('cada tentativa seguinte muda de ângulo, não só de intensidade', () => {
    const angulos = [2, 3, 4].map((n) => promptPorTrigger('reengajamento', 'Larissa', n))
    expect(angulos[0]).toContain('primeiro reforço')
    expect(angulos[1]).toContain('segundo reforço')
    expect(angulos[2]).toContain('terceiro reforço')
    expect(new Set(angulos).size).toBe(3)
  })

  it('o toque 3 oferece saída digna e o último fecha o ciclo sem pressão', () => {
    expect(anguloPorTentativa(3)).toContain('saída digna')
    expect(anguloPorTentativa(4)).toContain('Nunca pressione')
    expect(anguloPorTentativa(9)).toContain('último reforço')
  })
})

// Régua de pós-visita — o ebook "Captação Previsível" pede 5 toques em 14 dias.
describe('pós-visita — cronograma D0/D3/D7/D10/D14', () => {
  const agora = Date.now()
  it('tem 5 toques nos offsets certos (em horas)', () => {
    expect([...POS_VISITA_TOQUES_HORAS]).toEqual([0, 72, 168, 240, 336])
    expect(POS_VISITA_MAX_TOQUES).toBe(5)
  })
  it('o 1º toque (D0) vence assim que o lead entra na coluna', () => {
    expect(estaDevidoPosVisita(agora, 0, agora)).toBe(true)
  })
  it('o 2º toque (D3) só vence após 72h da entrada', () => {
    expect(estaDevidoPosVisita(agora - 71 * H, 1, agora)).toBe(false)
    expect(estaDevidoPosVisita(agora - 73 * H, 1, agora)).toBe(true)
  })
  it('o último toque (D14) só vence após 336h', () => {
    expect(estaDevidoPosVisita(agora - 335 * H, 4, agora)).toBe(false)
    expect(estaDevidoPosVisita(agora - 337 * H, 4, agora)).toBe(true)
  })
  it('não existe 6º toque (índice fora do cronograma)', () => {
    expect(estaDevidoPosVisita(agora - 1000 * H, 5, agora)).toBe(false)
  })
  it('sem data de entrada na coluna, nada vence', () => {
    expect(estaDevidoPosVisita(0, 0, agora)).toBe(false)
  })
})

describe('promptPosVisitaPorToque', () => {
  it('cada marco tem intenção distinta e todos travam a forma, sem travessão', () => {
    const marcos = [0, 1, 2, 3, 4].map((t) => promptPosVisitaPorToque('Larissa', t))
    expect(new Set(marcos).size).toBe(5)
    for (const m of marcos) {
      expect(m).toContain('Larissa')
      expect(m).toContain('Nunca use travessão')
      expect(m).not.toMatch(/[—–]/)
    }
  })
  it('D0 reaproveita a abordagem quente de pós-visita (um movimento, sem empilhar)', () => {
    expect(promptPosVisitaPorToque('Larissa', 0)).toContain('NÃO empilhe proposta de vaga nem valores')
  })
  it('D7 cita o depoimento quando fornecido, senão usa mensagem de valor', () => {
    const comDep = promptPosVisitaPorToque('Larissa', 2, 'meu filho floresceu na escola')
    expect(comDep).toContain('meu filho floresceu na escola')
    expect(promptPosVisitaPorToque('Larissa', 2)).toContain('no máximo 10 crianças')
  })
  it('índice acima do previsto cai no fechamento gentil (D14)', () => {
    expect(promptPosVisitaPorToque('Larissa', 9)).toContain('está tudo bem')
  })
})
