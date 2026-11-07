import { describe, it, expect } from 'vitest'
import { aguardarVagaIA, chaveRpm, RpmEsgotadoError } from './ia-rpm'

// Relógio falso: dormir avança o tempo, sem esperar de verdade.
function relogio() {
  let t = 0
  return { agora: () => t, dormir: async (ms: number) => { t += ms } }
}

function dbCom(respostas: (number | Error)[]) {
  const chamadas: Record<string, unknown>[] = []
  return {
    chamadas,
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      chamadas.push(args)
      const r = respostas.shift() ?? 0
      return r instanceof Error ? { data: null, error: r } : { data: r, error: null }
    },
  }
}

describe('aguardarVagaIA', () => {
  it('vaga livre: segue na hora', async () => {
    const db = dbCom([0])
    const c = relogio()
    expect(await aguardarVagaIA(db, 'gemini:m', 'alta', 'sara', c)).toBe(0)
    expect(db.chamadas[0]).toMatchObject({ p_chave: 'gemini:m', p_prioridade: 2, p_origem: 'sara' })
  })

  it('fila cheia: espera o tempo indicado e tenta de novo', async () => {
    const db = dbCom([3000, 0])
    const c = relogio()
    const esperou = await aguardarVagaIA(db, 'gemini:m', 'normal', undefined, c)
    expect(esperou).toBeGreaterThanOrEqual(3000)
    expect(db.chamadas).toHaveLength(2)
    expect(db.chamadas[1].p_espera_ms).toBeGreaterThanOrEqual(3000)
  })

  it('baixa prioridade desiste após o prazo (follow-up cede na rajada)', async () => {
    const db = dbCom([20_000, 20_000, 20_000])
    const c = relogio()
    await expect(aguardarVagaIA(db, 'gemini:m', 'baixa', 'followup', c)).rejects.toBeInstanceOf(RpmEsgotadoError)
  })

  it('alta prioridade nunca desiste: estoura o prazo e segue', async () => {
    const db = dbCom([50_000, 50_000])
    const c = relogio()
    await expect(aguardarVagaIA(db, 'gemini:m', 'alta', 'sara', c)).resolves.toBeGreaterThan(0)
  })

  it('erro no banco: segue sem fila (fail-open)', async () => {
    const db = dbCom([new Error('rpc caiu')])
    expect(await aguardarVagaIA(db, 'gemini:m', 'baixa', undefined, relogio())).toBe(0)
  })

  it('chave por provedor e modelo', () => {
    expect(chaveRpm('gemini', 'gemini-3.8-flash')).toBe('gemini:gemini-3.8-flash')
  })
})
