import { describe, it, expect } from 'vitest'
import { garantirTurnoFinalUsuario, ehRateLimit, esperaRetry } from './ia-credenciais'

describe('garantirTurnoFinalUsuario', () => {
  it('conversa terminando em fala nossa ganha turno final de usuário (Gemini recusa o contrário)', () => {
    const out = garantirTurnoFinalUsuario([
      { role: 'system', content: 's' },
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá!' },
    ])
    expect(out).toHaveLength(4)
    expect(out[3].role).toBe('user')
  })

  it('terminando em usuário, não mexe', () => {
    const msgs = [{ role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'oi' }]
    expect(garantirTurnoFinalUsuario(msgs)).toBe(msgs)
  })
})

describe('backoff de 429', () => {
  it('reconhece 429 e espera segundos, não milissegundos', () => {
    const e = Object.assign(new Error('429 Resource has been exhausted'), { status: 429 })
    expect(ehRateLimit(e)).toBe(true)
    expect(esperaRetry(e, 0)).toBeGreaterThanOrEqual(5000)
  })

  it('503 segue no backoff curto', () => {
    const e = Object.assign(new Error('503 high demand'), { status: 503 })
    expect(ehRateLimit(e)).toBe(false)
    expect(esperaRetry(e, 0)).toBeLessThan(1000)
  })
})
