// Fila de RPM das chamadas de IA (Fase 5 do plano de humanização, 07/11/2026).
//
// O Gemini grátis limita ~15 req/min POR MODELO. Várias funções serverless chamam o
// modelo ao mesmo tempo (webhook, follow-up, extração de ficha, memória, mídia), então
// a contagem precisa ser central: cada chamada reserva vaga em crm.ia_reservar_slot
// (advisory lock + janela deslizante de 60s em crm.ia_chamadas) antes de ir ao Google.
//
// Prioridade: 'alta' (turno da Sara/Salomão, mídia da família) usa o teto inteiro;
// 'normal' (Maestro, casos, treino) teto-2; 'baixa' (follow-up, ficha, memória) teto-4.
// Assim, na rajada, quem espera é o trabalho de fundo, não o lead que acabou de chegar.
//
// Teto em config_ia.ia_rpm_limite (null = sem limite, só registra — serve de métrica de
// pico). Falha do banco = segue sem fila (fail-open): a fila nunca derruba o atendimento.

export type PrioridadeIA = 'alta' | 'normal' | 'baixa'

const NIVEL: Record<PrioridadeIA, number> = { alta: 2, normal: 1, baixa: 0 }

// Quanto cada nível aceita esperar na fila. Alta: depois do prazo segue mesmo assim (o
// backoff de 429 em comRetry absorve). Normal/baixa: desiste com RpmEsgotadoError e o
// chamador trata (follow-up tenta no próximo ciclo; ficha/memória são best-effort).
const PRAZO_MS: Record<PrioridadeIA, number> = { alta: 60_000, normal: 45_000, baixa: 25_000 }

export class RpmEsgotadoError extends Error {
  constructor(chave: string, esperouMs: number) {
    super(`ia_rpm: sem vaga para ${chave} após ${Math.round(esperouMs / 1000)}s (fila cheia)`)
    this.name = 'RpmEsgotadoError'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> }

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Chave da fila: o limite do Gemini é por modelo. */
export function chaveRpm(provedor: string, model: string): string {
  return `${provedor}:${model}`
}

/**
 * Espera até haver vaga para mais uma chamada nesta chave e a registra.
 * Devolve quanto esperou (ms).
 */
export async function aguardarVagaIA(
  db: DbRpc,
  chave: string,
  prioridade: PrioridadeIA = 'normal',
  origem?: string,
  opts?: { prazoMs?: number; agora?: () => number; dormir?: (ms: number) => Promise<unknown> }
): Promise<number> {
  const agora = opts?.agora ?? Date.now
  const sleep = opts?.dormir ?? dormir
  const prazo = opts?.prazoMs ?? PRAZO_MS[prioridade]
  const ini = agora()
  for (;;) {
    const esperou = agora() - ini
    let espera: number
    try {
      const { data, error } = await db.rpc('ia_reservar_slot', {
        p_chave: chave,
        p_prioridade: NIVEL[prioridade],
        p_origem: origem ?? null,
        p_espera_ms: Math.round(esperou),
      })
      if (error) throw error
      espera = Number(data) || 0
    } catch (e) {
      console.error('[ia-rpm] reserva falhou, seguindo sem fila:', e instanceof Error ? e.message : e)
      return esperou
    }
    if (espera <= 0) return esperou
    if (esperou + espera > prazo) {
      if (prioridade === 'alta') {
        console.warn(`[ia-rpm] ${chave}: prazo da fila estourado, seguindo (backoff de 429 cobre)`)
        return esperou
      }
      throw new RpmEsgotadoError(chave, esperou)
    }
    // Jitter: funções que acordam juntas não brigam pela mesma vaga.
    await sleep(espera + Math.random() * 400)
  }
}
