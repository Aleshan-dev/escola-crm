import { describe, it, expect } from 'vitest'
import { validarResposta } from './validar-resposta'

describe('validarResposta — promessa de condição comercial', () => {
  it.each([
    'Temos um desconto especial para você',
    'Posso conseguir uma bolsa de 50%',
    'Aceitamos convênio com a sua empresa',
    'A primeira mensalidade é gratuita',
  ])('veta "%s"', (txt) => {
    const r = validarResposta(txt)
    expect(r.ok).toBe(false)
    expect(r.vetos.map((v) => v.codigo)).toContain('promessa_desconto_condicao')
  })
})

describe('validarResposta — valor monetário sem preço oficial liberado', () => {
  it('veta R$ quando preço não está liberado (default)', () => {
    const r = validarResposta('A mensalidade é R$ 1.947 no integral')
    expect(r.vetos.map((v) => v.codigo)).toContain('valor_monetario')
  })

  it('NÃO veta valor quando o preço oficial está liberado', () => {
    const r = validarResposta('A mensalidade é R$ 1.947', { precoOficialLiberado: true })
    expect(r.vetos.map((v) => v.codigo)).not.toContain('valor_monetario')
  })
})

describe('validarResposta — fatos proibidos injetados', () => {
  it('veta afirmação de natação/piscina quando configurado', () => {
    const r = validarResposta('Sim, temos aulas de natação na piscina!', {
      fatosProibidos: [{ padrao: /nata[cç]\w*|piscina/i, rotulo: 'natacao_piscina' }],
    })
    expect(r.ok).toBe(false)
    expect(r.vetos.map((v) => v.codigo)).toContain('fato_proibido')
  })
})

describe('validarResposta — resposta limpa passa', () => {
  it('texto institucional neutro é ok', () => {
    const r = validarResposta('Olá! Que alegria seu interesse. Podemos agendar uma visita?')
    expect(r.ok).toBe(true)
    expect(r.vetos).toHaveLength(0)
    expect(r.corpoSaneado.length).toBeGreaterThan(0)
  })
})
