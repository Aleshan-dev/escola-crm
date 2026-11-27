import { describe, expect, it } from 'vitest'
import { ARCA, destinoNoArca } from './telas-desligadas'

describe('telas antigas do CRM → ARCA', () => {
  it('redireciona cada tela para a equivalente', () => {
    expect(destinoNoArca('/kanban')).toBe(`${ARCA}/comercial/funil`)
    expect(destinoNoArca('/chat')).toBe(`${ARCA}/comercial/conversas`)
    expect(destinoNoArca('/agendamentos')).toBe(`${ARCA}/comercial/agenda-de-visitas`)
    expect(destinoNoArca('/responsaveis/abc')).toBe(`${ARCA}/comercial/funil`)
    expect(destinoNoArca('/configuracoes/salomao/auditoria')).toBe(`${ARCA}/comercial/ia-avancado`)
    expect(destinoNoArca('/configuracoes/salomao')).toBe(`${ARCA}/comercial/agentes-ia`)
    expect(destinoNoArca('/configuracoes/waha')).toBe(`${ARCA}/comercial/motor-whatsapp`)
    expect(destinoNoArca('/')).toBe(`${ARCA}/comercial/funil`)
  })

  it('mantém o motor e as telas que precisam deste domínio', () => {
    for (const p of [
      '/api/webhook/whatsapp',
      '/api/cron/followup',
      '/api/google/push-tarefa',
      '/api/midia',
      '/login',
      '/auth/callback',
      '/configuracoes/integracoes',
      '/configuracoes/whatsapp-oficial',
      '/privacy',
      '/termos',
      '/sem-acesso',
      '/logo.png',
    ]) {
      expect(destinoNoArca(p), p).toBeNull()
    }
  })

  it('não confunde prefixo parecido', () => {
    expect(destinoNoArca('/casosx')).toBe(`${ARCA}/comercial/funil`)
    expect(destinoNoArca('/configuracoes/integracoes-x')).toBe(`${ARCA}/comercial/motor-whatsapp`)
  })
})
