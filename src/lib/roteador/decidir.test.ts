import { describe, it, expect } from 'vitest'
import { escolherAgente } from './decidir'

describe('escolherAgente — roteador determinístico', () => {
  it('novo/captação ⇒ Sara', () => {
    expect(escolherAgente({ jaResponsavel: false, salomaoAtivo: false })).toEqual({
      rota: 'sara',
      motivo: 'novo_sara',
    })
    expect(escolherAgente({ jaResponsavel: false, salomaoAtivo: true }).rota).toBe('sara')
  })

  it('matriculado + Salomão ativo ⇒ Salomão', () => {
    expect(escolherAgente({ jaResponsavel: true, salomaoAtivo: true })).toEqual({
      rota: 'salomao',
      motivo: 'matriculado_salomao',
    })
  })

  it('matriculado + Salomão desligado ⇒ humano (fallback seguro)', () => {
    expect(escolherAgente({ jaResponsavel: true, salomaoAtivo: false })).toEqual({
      rota: 'humano',
      motivo: 'matriculado_humano',
    })
  })
})
