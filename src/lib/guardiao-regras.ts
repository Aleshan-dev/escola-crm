// Regras PURAS do guardião do Evolution (sem rede, sem banco) — testáveis.
//
// Contexto (INCIDENTE-FOLLOWUP-PARADO-2026-07-29): o gateway Evolution caiu por
// volta das 18h de Acre e a escola ficou muda até o dia seguinte sem UM alerta.
// Este módulo decide, a cada rodada do cron, o que fazer: nada, reiniciar por
// rotina (06:00 Acre) ou reiniciar para recuperar uma instância caída.

import { ACRE_SHIFT_MS } from '@/lib/disponibilidade'

/** Hora do restart preventivo diário, no fuso de Rio Branco/Acre. */
export const HORA_RESTART_DIARIO = 6

/**
 * Espera mínima entre dois restarts. Protege contra loop: se a instância sobe
 * quebrada, sem isto o cron reiniciaria a cada 15 min para sempre.
 */
export const COOLDOWN_RESTART_MS = 30 * 60 * 1000

/** Estados que o Evolution reporta em /instance/connectionState. */
export type EstadoInstancia = 'open' | 'connecting' | 'close' | 'desconhecido'

export type AcaoGuardiao =
  | 'nada'
  | 'restart_diario'
  | 'restart_recuperacao'
  | 'cooldown'
  | 'aguardando_conexao'

export type EntradaGuardiao = {
  agoraMs: number
  estado: EstadoInstancia
  /** Timestamp do último restart disparado por nós (0 = nunca). */
  ultimoRestartMs: number
  /** true quando a rodada veio do agendamento diário das 06:00. */
  janelaDiaria: boolean
}

/** Minutos desde o último restart (Infinity se nunca houve). */
export function minutosDesdeRestart(ultimoRestartMs: number, agoraMs: number): number {
  if (!ultimoRestartMs) return Infinity
  return (agoraMs - ultimoRestartMs) / 60000
}

/** Hora (0-23) no fuso de Acre. */
export function horaAcreDe(agoraMs: number): number {
  return new Date(agoraMs + ACRE_SHIFT_MS).getUTCHours()
}

/**
 * Decide a ação da rodada.
 *
 * Ordem importa:
 * 1. Cooldown vence tudo. Nunca reiniciar duas vezes seguidas sem esperar.
 * 2. 'connecting' não é falha: a instância está subindo. Esperar, não reiniciar.
 * 3. Restart diário só na janela agendada.
 * 4. Instância caída ('close') em qualquer rodada dispara recuperação.
 */
export function decidirAcao(e: EntradaGuardiao): AcaoGuardiao {
  const desde = minutosDesdeRestart(e.ultimoRestartMs, e.agoraMs)
  const emCooldown = desde < COOLDOWN_RESTART_MS / 60000

  if (e.estado === 'connecting') return 'aguardando_conexao'
  if (emCooldown) return 'cooldown'
  if (e.janelaDiaria) return 'restart_diario'
  if (e.estado === 'close' || e.estado === 'desconhecido') return 'restart_recuperacao'
  return 'nada'
}

/** A instância está realmente saudável? */
export function instanciaSaudavel(estado: EstadoInstancia): boolean {
  return estado === 'open'
}

/**
 * Normaliza a resposta do Evolution. O formato varia entre versões:
 * às vezes `{ instance: { state } }`, às vezes `{ state }`.
 */
export function lerEstado(payload: unknown): EstadoInstancia {
  const p = payload as { state?: string; instance?: { state?: string } } | null
  const bruto = p?.instance?.state ?? p?.state
  if (bruto === 'open' || bruto === 'connecting' || bruto === 'close') return bruto
  return 'desconhecido'
}
