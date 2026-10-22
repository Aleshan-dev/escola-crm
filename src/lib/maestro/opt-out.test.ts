import { describe, it, expect } from 'vitest'
import { detectarOptOut, normalizar } from './opt-out'

describe('detectarOptOut — palavra isolada', () => {
  it.each(['parar', 'PARAR', 'Parar.', ' sair ', 'stop', 'cancelar', 'descadastrar', 'remover'])(
    'mensagem inteira "%s" é opt-out',
    (txt) => expect(detectarOptOut(txt)).toBe(true)
  )
})

describe('detectarOptOut — verbo de cessação + objeto de comunicação', () => {
  it.each([
    'quero parar de receber mensagens',
    'me tira da lista por favor',
    'pode cancelar esse contato',
    'não quero mais receber',
    'nao quero mais ser contatado',
    'remover meu número da divulgação',
  ])('"%s" é opt-out', (txt) => expect(detectarOptOut(txt)).toBe(true))
})

describe('detectarOptOut — NÃO é opt-out (conservador)', () => {
  it.each([
    'não consigo parar de pensar na escola',
    'vou sair do trabalho e passo aí',
    'quero saber o valor da mensalidade',
    'a visita pode parar na recepção?',
    '',
    '   ',
  ])('"%s" não é opt-out', (txt) => expect(detectarOptOut(txt)).toBe(false))

  it('null/undefined não quebram', () => {
    expect(detectarOptOut(null)).toBe(false)
    expect(detectarOptOut(undefined)).toBe(false)
  })
})

describe('normalizar', () => {
  it('tira acento, pontuação e colapsa espaço', () => {
    expect(normalizar('  Não   QUERO, receber! ')).toBe('nao quero receber')
  })
})
