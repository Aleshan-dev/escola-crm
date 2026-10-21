import { describe, expect, it } from 'vitest'
import { candidatosBR } from './waha'

describe('candidatosBR', () => {
  it('completa o 55 de celular BR salvo sem código do país', () => {
    expect(candidatosBR('68992624996')).toEqual(['5568992624996', '556892624996'])
    expect(candidatosBR('61982538470')[0]).toBe('5561982538470')
  })

  it('mantém número já com 55 e alterna o 9º dígito', () => {
    expect(candidatosBR('5568992624996')).toEqual(['5568992624996', '556892624996'])
    expect(candidatosBR('556892624996')).toEqual(['556892624996', '5568992624996'])
  })

  it('não mexe em número estrangeiro', () => {
    expect(candidatosBR('447974045725')).toEqual(['447974045725'])
    expect(candidatosBR('12125550123')).toEqual(['12125550123'])
  })
})
