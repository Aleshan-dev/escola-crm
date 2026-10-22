import { describe, it, expect } from 'vitest'
import { decidirPolitica, type EstadoDePolitica } from './politica'

const base: EstadoDePolitica = {
  optOut: false,
  precisaAtendimentoHumano: false,
  iaAtiva: true,
  jaResponsavel: false,
  salomaoAtivo: false,
}

describe('decidirPolitica — precedência dos vetos', () => {
  it('opt-out vence tudo', () => {
    const d = decidirPolitica({ ...base, optOut: true, jaResponsavel: true, salomaoAtivo: true })
    expect(d).toEqual({ permite: false, rota: 'humano', motivo: 'opt_out' })
  })

  it('atendimento humano forçado não responde', () => {
    const d = decidirPolitica({ ...base, precisaAtendimentoHumano: true })
    expect(d).toEqual({ permite: false, rota: 'humano', motivo: 'force_human' })
  })

  it('IA pausada (ia_ativa=false) não responde — inclui pausa manual ADR-005', () => {
    const d = decidirPolitica({ ...base, iaAtiva: false, jaResponsavel: true, salomaoAtivo: true })
    expect(d).toEqual({ permite: false, rota: 'humano', motivo: 'ia_pausada' })
  })
})

describe('decidirPolitica — escolha do agente (sem vetos)', () => {
  it('lead novo vai para a Sara', () => {
    expect(decidirPolitica(base)).toEqual({ permite: true, rota: 'sara', motivo: 'novo_sara' })
  })

  it('matriculado + Salomão ativo vai para o Salomão', () => {
    const d = decidirPolitica({ ...base, jaResponsavel: true, salomaoAtivo: true })
    expect(d).toEqual({ permite: true, rota: 'salomao', motivo: 'matriculado_salomao' })
  })

  it('matriculado + Salomão desligado vira atendimento humano (sem IA comercial)', () => {
    const d = decidirPolitica({ ...base, jaResponsavel: true, salomaoAtivo: false })
    expect(d).toEqual({ permite: false, rota: 'humano', motivo: 'matriculado_humano' })
  })
})

describe('decidirPolitica — paridade com o comportamento legado (flags off ⇒ opt-out nunca liga)', () => {
  // Sem Maestro, o legado respondia Sara p/ novo e Salomão p/ matriculado, com as
  // mesmas guardas de ia_ativa/force_human. optOut=false reproduz exatamente isso.
  it('novo + IA ativa ⇒ Sara responde', () => {
    expect(decidirPolitica({ ...base, optOut: false }).rota).toBe('sara')
  })
})
