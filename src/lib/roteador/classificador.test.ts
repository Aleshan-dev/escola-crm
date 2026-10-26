import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/ia-credenciais', () => ({ chamarModeloIA: vi.fn() }))

import { interpretarClassificacao, montarPromptClassificador, type Intencao } from './classificador'
import { resolverRota } from './resolver'
import type { DecisaoDaPolitica } from '@/lib/maestro/politica'

const INTENCOES: Intencao[] = [
  { nome: 'reclamacao', descricao: 'reclama', exemplos: ['absurdo'], agente: 'humano' },
  { nome: 'matricula_e_visita', descricao: 'quer visitar', exemplos: [], agente: 'sara' },
  { nome: 'financeiro_matriculado', descricao: 'boleto', exemplos: [], agente: 'salomao' },
]
const NOMES = INTENCOES.map((i) => i.nome)

describe('interpretarClassificacao', () => {
  it('aceita intenção cadastrada e limita a confiança a 0–1', () => {
    expect(interpretarClassificacao('{"intencao":"reclamacao","confianca":1.7}', NOMES)).toEqual({ ok: true, intencao: 'reclamacao', confianca: 1 })
    expect(interpretarClassificacao('{"intencao":"reclamacao","confianca":-2}', NOMES)).toEqual({ ok: true, intencao: 'reclamacao', confianca: 0 })
    expect(interpretarClassificacao('{"intencao":"reclamacao","confianca":"x"}', NOMES)).toEqual({ ok: true, intencao: 'reclamacao', confianca: 0 })
  })
  it('none vira intencao null', () => {
    expect(interpretarClassificacao('{"intencao":"none","confianca":0.9}', NOMES)).toEqual({ ok: true, intencao: null, confianca: 0.9 })
  })
  it('recusa intenção desconhecida e JSON inválido', () => {
    expect(interpretarClassificacao('{"intencao":"inventada","confianca":0.9}', NOMES)).toEqual({ ok: false, erro: 'intencao_desconhecida' })
    expect(interpretarClassificacao('não é json', NOMES)).toEqual({ ok: false, erro: 'json_invalido' })
    expect(interpretarClassificacao('{"confianca":0.9}', NOMES)).toEqual({ ok: false, erro: 'json_invalido' })
  })
})

describe('montarPromptClassificador', () => {
  it('lista as intenções, o none e o histórico só como contexto', () => {
    const [sys, user] = montarPromptClassificador(INTENCOES, 'sim', [{ de: 'escola', texto: 'Quer agendar?' }])
    expect(sys.content).toContain('- reclamacao: reclama')
    expect(sys.content).toContain('"absurdo"')
    expect(sys.content).toContain('- none:')
    expect(user.content).toContain('Escola: Quer agendar?')
    expect(user.content).toContain('Última mensagem do cliente:\nsim')
  })
})

describe('resolverRota', () => {
  const sara: DecisaoDaPolitica = { permite: true, rota: 'sara', motivo: 'novo_sara' }
  const salomao: DecisaoDaPolitica = { permite: true, rota: 'salomao', motivo: 'matriculado_salomao' }
  const pausada: DecisaoDaPolitica = { permite: false, rota: 'humano', motivo: 'ia_pausada' }
  const ok = (intencao: string | null, confianca: number) => ({ ok: true as const, intencao, confianca })

  it('classificador desligado = exatamente a guarda (regressão)', () => {
    expect(resolverRota(sara, null, INTENCOES, 0.6)).toEqual({ rota: 'sara', permite: true, resultado: 'guarda', intencao: null, confianca: null })
    expect(resolverRota(salomao, null, INTENCOES, 0.6).rota).toBe('salomao')
  })
  it('guarda que não permite resposta não é reaberta pela intenção', () => {
    expect(resolverRota(pausada, ok('matricula_e_visita', 0.99), INTENCOES, 0.6)).toMatchObject({ rota: 'humano', permite: false, resultado: 'guarda' })
  })
  it('intenção de humano com confiança suficiente escala', () => {
    expect(resolverRota(sara, ok('reclamacao', 0.8), INTENCOES, 0.6)).toMatchObject({ rota: 'humano', permite: false, resultado: 'escalado_humano', intencao: 'reclamacao' })
    expect(resolverRota(salomao, ok('reclamacao', 0.8), INTENCOES, 0.6)).toMatchObject({ rota: 'humano', resultado: 'escalado_humano' })
  })
  it('abaixo do mínimo, none ou falha: mantém o agente da guarda', () => {
    expect(resolverRota(sara, ok('reclamacao', 0.59), INTENCOES, 0.6)).toMatchObject({ rota: 'sara', permite: true, resultado: 'baixa_confianca' })
    expect(resolverRota(sara, ok(null, 0.9), INTENCOES, 0.6)).toMatchObject({ rota: 'sara', resultado: 'sem_match' })
    expect(resolverRota(salomao, { ok: false, erro: 'timeout' }, INTENCOES, 0.6)).toMatchObject({ rota: 'salomao', resultado: 'falha' })
  })
  it('intenção que confirma a guarda = classificado', () => {
    expect(resolverRota(sara, ok('matricula_e_visita', 0.9), INTENCOES, 0.6)).toMatchObject({ rota: 'sara', resultado: 'classificado' })
  })
  it('guarda veta outro agente de IA: matriculado nunca vai para a Sara', () => {
    expect(resolverRota(salomao, ok('matricula_e_visita', 0.99), INTENCOES, 0.6)).toMatchObject({ rota: 'salomao', permite: true, resultado: 'vetado_guarda' })
    expect(resolverRota(sara, ok('financeiro_matriculado', 0.99), INTENCOES, 0.6)).toMatchObject({ rota: 'sara', resultado: 'vetado_guarda' })
  })
})
