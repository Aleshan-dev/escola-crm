import { describe, it, expect } from 'vitest'
import { dividirEmBaloes } from './baloes'

describe('dividirEmBaloes', () => {
  it('quebra por parágrafos (linha em branco)', () => {
    expect(dividirEmBaloes('Olá!\n\nTudo bem?')).toEqual(['Olá!', 'Tudo bem?'])
  })

  it('no máximo 3 balões', () => {
    expect(dividirEmBaloes('a\n\nb\n\nc\n\nd\n\ne').length).toBe(3)
  })

  // REGRESSÃO 30/10/2026 — a quebra por frase cortava "R$ 1.297,00" em "R$ 1." +
  // "297,00" porque o ponto de milhar virava fim de frase.
  it('não corta o valor no ponto de milhar quando quebra um bloco longo', () => {
    const texto =
      'Para o período parcial em 2026 o investimento mensal é de R$ 1.297,00 e já inclui ' +
      'todo o material didático do Sistema Acrescer, a alimentação preparada por nutricionista ' +
      'na própria escola e a nossa estrutura completa com duas educadoras por sala.'
    const baloes = dividirEmBaloes(texto)
    expect(baloes.join(' ')).toContain('R$ 1.297,00')
    for (const b of baloes) expect(b).not.toMatch(/R\$ 1\.$/)
  })
})
