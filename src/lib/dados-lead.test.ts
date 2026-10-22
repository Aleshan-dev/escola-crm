import { describe, expect, it } from 'vitest'
import { normalizarCrianca, normalizarData, normalizarIdade } from './dados-lead'

describe('normalizarIdade', () => {
  it('aceita número', () => expect(normalizarIdade(3)).toEqual({ idade: 3, idade_meses: null }))
  it('aceita texto "2 anos" (o caso que derrubava o insert)', () =>
    expect(normalizarIdade('2 anos')).toEqual({ idade: 2, idade_meses: null }))
  it('aceita número em string', () => expect(normalizarIdade('4')).toEqual({ idade: 4, idade_meses: null }))
  it('anos e meses', () => expect(normalizarIdade('3 anos e 5 meses')).toEqual({ idade: 3, idade_meses: 5 }))
  it('só meses = bebê de 0 anos', () => expect(normalizarIdade('9 meses')).toEqual({ idade: 0, idade_meses: 9 }))
  it('ano e meio', () => expect(normalizarIdade('1 ano e meio')).toEqual({ idade: 1, idade_meses: 6 }))
  it('por extenso', () => expect(normalizarIdade('dois anos')).toEqual({ idade: 2, idade_meses: null }))
  it('fração', () => expect(normalizarIdade(1.5)).toEqual({ idade: 1, idade_meses: 6 }))
  it('meses separados', () => expect(normalizarIdade(0, 8)).toEqual({ idade: 0, idade_meses: 8 }))
  it('18 meses vira 1 ano e 6', () => expect(normalizarIdade(null, 18)).toEqual({ idade: 1, idade_meses: 6 }))
  it('lixo vira null', () => expect(normalizarIdade('não sei')).toEqual({ idade: null, idade_meses: null }))
})

describe('normalizarData', () => {
  it('ISO', () => expect(normalizarData('2023-03-15')).toBe('2023-03-15'))
  it('BR', () => expect(normalizarData('15/03/2023')).toBe('2023-03-15'))
  it('inválida', () => expect(normalizarData('31/02/2023')).toBeNull())
  it('texto', () => expect(normalizarData('março')).toBeNull())
})

describe('normalizarCrianca', () => {
  it('só colunas válidas e tipadas', () =>
    expect(
      normalizarCrianca({ nome: ' Ely Davi ', idade: '2 anos', periodo: 'Integral', motivo_busca: '', data_nascimento: 'ontem' })
    ).toEqual({ nome: 'Ely Davi', idade: 2, periodo: 'Integral' }))
})
