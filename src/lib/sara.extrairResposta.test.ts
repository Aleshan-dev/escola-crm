import { describe, it, expect } from 'vitest'
import { extrairRespostaParcial } from './sara'

// REGRESSÃO 30/10/2026 — JSON truncado pelo maxTokens caía no fallback do catch e a
// família recebia `{ "resposta": "..."` cru. O resgate devolve só o texto, sem chaves.
describe('extrairRespostaParcial', () => {
  it('resgata a resposta de um JSON truncado (sem fechamento), decodificando \\n', () => {
    const raw = '{\n "resposta": "Vamos agendar para terça.\\n\\nO valor é R$ 1.297,00 mensais, já com'
    const r = extrairRespostaParcial(raw)
    expect(r).toContain('Vamos agendar para terça.')
    expect(r).toContain('R$ 1.297,00')
    expect(r).not.toContain('"resposta"')
    expect(r).not.toContain('{')
  })

  it('para na aspa de fechamento quando o JSON está completo', () => {
    const raw = '{"resposta":"Oi, tudo bem?","transbordo":false}'
    expect(extrairRespostaParcial(raw)).toBe('Oi, tudo bem?')
  })

  it('devolve null quando não há campo resposta', () => {
    expect(extrairRespostaParcial('{"transbordo":true}')).toBeNull()
    expect(extrairRespostaParcial('texto solto sem json')).toBeNull()
  })

  it('preserva aspas e barras escapadas', () => {
    const raw = '{"resposta":"Ela disse \\"oi\\" e saiu"}'
    expect(extrairRespostaParcial(raw)).toBe('Ela disse "oi" e saiu')
  })
})
