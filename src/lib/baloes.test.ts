import { describe, it, expect } from 'vitest'
import { dividirEmBaloes, MAX_PALAVRAS_BALAO } from './baloes'

const palavras = (s: string) => s.split(/\s+/).filter(Boolean).length

describe('dividirEmBaloes', () => {
  it('quebra por parágrafos (linha em branco)', () => {
    expect(dividirEmBaloes('Olá!\n\nTudo bem?')).toEqual(['Olá!', 'Tudo bem?'])
  })

  it('nunca descarta texto (o antigo teto de 3 balões cortava o fim)', () => {
    const b = dividirEmBaloes('a\n\nb\n\nc\n\nd')
    expect(b).toEqual(['a', 'b', 'c', 'd'])
  })

  it('rajada: acima de 6 balões o excedente vai para o último, sem perder nada', () => {
    const b = dividirEmBaloes('a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng\n\nh')
    expect(b).toHaveLength(6)
    expect(b.join(' ')).toBe('a b c d e f g h')
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

  // 10/11/2026 — caso real enviado pelo gestor: um parágrafo de ~75 palavras num balão só.
  it('nenhum balão passa de 35 palavras e o texto inteiro é preservado', () => {
    const texto =
      'Para o berçário em 2027, o valor mensal já inclui todo o material didático do Sistema ACRESCER, ' +
      'alimentação preparada na escola com cardápio de nutricionista, câmeras ao vivo pelo app e duas ' +
      'educadoras por sala para garantir aquele cuidado bem pertinho: no período Parcial (07:00 às 11:00) ' +
      'o investimento é de R$ 1.647,00, no Estendido (07:00 às 14:00) fica R$ 1.797,00 e no Integral ' +
      '(07:00 às 17:00) é R$ 1.947,00.'
    const baloes = dividirEmBaloes(texto)
    expect(baloes.length).toBeGreaterThan(1)
    for (const b of baloes) expect(palavras(b)).toBeLessThanOrEqual(MAX_PALAVRAS_BALAO)
    expect(baloes.join(' ').replace(/\s+/g, ' ')).toBe(texto)
    for (const v of ['R$ 1.647,00', 'R$ 1.797,00', 'R$ 1.947,00']) expect(baloes.join(' ')).toContain(v)
  })

  it('frase sem pontuação acima do limite é cortada por palavras', () => {
    const texto = Array.from({ length: 80 }, (_, i) => `p${i}`).join(' ')
    const baloes = dividirEmBaloes(texto)
    for (const b of baloes) expect(palavras(b)).toBeLessThanOrEqual(MAX_PALAVRAS_BALAO)
    expect(baloes.join(' ')).toBe(texto)
  })

  it('resposta curta continua num balão só', () => {
    expect(dividirEmBaloes('Oi, Ana! Qual a idade do Pedro?')).toEqual(['Oi, Ana! Qual a idade do Pedro?'])
  })
})
