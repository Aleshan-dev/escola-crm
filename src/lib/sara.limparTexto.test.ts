import { describe, it, expect } from 'vitest'
import { limparTexto } from './sara'

// AUDITORIA CMO 2026-07-29 — casos extraídos do corpus real de produção.
describe('limparTexto', () => {
  it('troca travessão por vírgula (caso real: convite de visita)', () => {
    expect(
      limparTexto('Consigo te receber quarta-feira, 29/07 às 07:30 ou às 08:30 — qual horário fica melhor?')
    ).toBe('Consigo te receber quarta-feira, 29/07 às 07:30 ou às 08:30, qual horário fica melhor?')
  })

  it('troca meia-risca por vírgula (caso real: endereço)', () => {
    expect(limparTexto('Rua Avestruz, nº 271, Rio Branco – Acre.')).toBe(
      'Rua Avestruz, nº 271, Rio Branco, Acre.'
    )
  })

  it('remove placeholder vazado (caso real: Ana Paula, 13/07)', () => {
    expect(limparTexto('o que você busca para o desenvolvimento do(a) [nome da criança] 😊')).toBe(
      'o que você busca para o desenvolvimento do(a) 😊'
    )
  })

  it('PRESERVA a linha em branco que separa os balões', () => {
    const entrada = 'Ótima pergunta, Helen — faz total sentido 💛\n\nConsigo te receber quinta, 30/07 às 9h?'
    expect(limparTexto(entrada)).toBe(
      'Ótima pergunta, Helen, faz total sentido 💛\n\nConsigo te receber quinta, 30/07 às 9h?'
    )
  })

  it('não deixa vírgula órfã no fim do balão', () => {
    expect(limparTexto('Vamos alinhar tudo pessoalmente —')).toBe('Vamos alinhar tudo pessoalmente')
  })

  it('não altera texto que já está correto', () => {
    const ok = 'Oi, Helen! Qual o nome e a idade da sua criança? 😊'
    expect(limparTexto(ok)).toBe(ok)
  })

  it('trata nulo e vazio', () => {
    expect(limparTexto(null)).toBe('')
    expect(limparTexto(undefined)).toBe('')
  })
})
