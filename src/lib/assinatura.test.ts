import { describe, it, expect } from 'vitest'
import { assinar, nomeAssinaturaDoUsuario } from './assinatura'

describe('assinar', () => {
  it('prepõe "Nome:\\n" ao texto', () => {
    expect(assinar('Sara', 'Oi, tudo bem?')).toBe('Sara:\nOi, tudo bem?')
  })
  it('é idempotente (não duplica a assinatura)', () => {
    expect(assinar('Sara', 'Sara:\nOi')).toBe('Sara:\nOi')
  })
  it('sem nome, devolve o texto como está', () => {
    expect(assinar('', 'Oi')).toBe('Oi')
    expect(assinar(null, 'Oi')).toBe('Oi')
  })
  it('texto vazio volta vazio', () => {
    expect(assinar('Sara', '')).toBe('')
  })
})

describe('nomeAssinaturaDoUsuario', () => {
  it('usa o primeiro nome do metadata quando há', () => {
    expect(nomeAssinaturaDoUsuario({ email: 'x@y.com', user_metadata: { nome: 'Aleshan Silva' } })).toBe('Aleshan')
    expect(nomeAssinaturaDoUsuario({ user_metadata: { full_name: 'Maria Souza' } })).toBe('Maria')
  })
  it('deriva do e-mail (parte local, sem dígitos) quando não há nome', () => {
    expect(nomeAssinaturaDoUsuario({ email: 'aleshan87@gmail.com' })).toBe('Aleshan')
    expect(nomeAssinaturaDoUsuario({ email: 'maria.souza@x.com' })).toBe('Maria')
  })
  it('sem dados, devolve string vazia', () => {
    expect(nomeAssinaturaDoUsuario(null)).toBe('')
    expect(nomeAssinaturaDoUsuario({ email: '' })).toBe('')
  })
})
