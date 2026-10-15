import { describe, it, expect } from 'vitest'
import { celularParaEvolution } from './convites'

// O Arca entrega `celular` mascarado — "(68) 99999-9999" — enquanto a fila de
// boletos já vem em E.164. A normalização é do lado do CRM, e um erro aqui não
// gera exceção: manda o convite de uma família para o número de outra. Daí os
// testes de recusa serem mais importantes que os de sucesso.

describe('celularParaEvolution', () => {
  it('normaliza o formato mascarado do Arca para E.164 sem +', () => {
    expect(celularParaEvolution('(68) 99999-0000')).toBe('5568999990000')
    expect(celularParaEvolution('(68) 99982-2731')).toBe('5568999822731')
  })

  it('reconstrói o 9º dígito quando o número vem no formato antigo', () => {
    // 10 dígitos (DDD + 8): é a causa clássica de não casar no WhatsApp.
    expect(celularParaEvolution('(68) 9982-2731')).toBe('5568999822731')
  })

  it('aceita número que já vem com o código do país', () => {
    expect(celularParaEvolution('5568999822731')).toBe('5568999822731')
    expect(celularParaEvolution('+55 (68) 99982-2731')).toBe('5568999822731')
  })

  it('recusa número curto demais para ter DDD', () => {
    expect(celularParaEvolution('99982-2731')).toBeNull()
    expect(celularParaEvolution('2731')).toBeNull()
  })

  it('recusa número longo demais ou com código de país estranho', () => {
    // Sem esta guarda, normalizarCelularBR faria slice(-11) e inventaria um
    // celular plausível a partir de lixo — enviando para quem não devia.
    expect(celularParaEvolution('1155689998227311')).toBeNull()
    // 12 dígitos que NÃO começam com 55: sem a segunda guarda, o slice(-11)
    // devolveria um celular brasileiro plausível para um número estrangeiro.
    expect(celularParaEvolution('016899982273')).toBeNull()
  })

  it('recusa vazio e texto sem dígitos', () => {
    expect(celularParaEvolution('')).toBeNull()
    expect(celularParaEvolution('não informado')).toBeNull()
  })
})
