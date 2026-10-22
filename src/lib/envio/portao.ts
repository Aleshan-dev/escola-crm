// PORTÃO ÚNICO DE ENVIO — proteção anti-ban do WhatsApp.
//
// Todo envio automático (resposta da IA, follow-up, Salomão, convites,
// reengajamento) e o envio manual passam por aqui ANTES do transporte. A
// ordem dos portões:
//
//   1. opt-out       (familias.opt_out_em)       → vetado
//   2. janela        (resposta ou disparo)        → adiado
//   3. repetição     (texto ~igual às últimas 20) → vetado
//   4. reserva       (crm.envio_reservar: teto do dia + intervalo, atômica por canal) → adiado
//   5. espera do intervalo → transporte → crm.envio_confirmar
//
// Modo (`PROTECAO_ENVIO_MODO`): `off` passa direto; `log` (default) NÃO barra
// nada — registra no ledger o que barraria ('vetaria'/'adiado') e envia; `ativo`
// barra. Envio manual nunca é barrado: o que barraria vira aviso.
//
// Falha do próprio portão (banco fora) é fail-open: envia e loga. Proteção que
// derruba o atendimento é pior que a falta dela.
//
// Não garante que o WhatsApp não bloqueie o número — reduz padrões locais de
// risco (rajada, volume de número novo, cópia repetida). Ver docs/PROTECAO-ENVIO.md.

import { createHash } from 'crypto'
import { createServerAdminClient } from '@/lib/supabase-server'
import {
  BAN_RISK, ESPERA_MAX_MS, ORIGEM_CHECA_REPETICAO, ORIGEM_PROATIVA, REPETICAO, modoProtecao,
  type Canal, type ConfigCanal, type ModoProtecao, type OrigemEnvio,
} from './defaults'
import { lerConfigCanal } from './config'
import { avaliarJanela, avaliarRepeticao, intervaloComJitter, normalizar, tetoDoDia } from './regras'

export interface ContextoEnvio {
  origem: OrigemEnvio
  canal: Canal
  telefone?: string | null
  leadId?: string | null
  familiaId?: string | null
}

export type MotivoBloqueio =
  | 'opt_out' | 'fora_da_janela' | 'domingo' | 'repeticao' | 'teto_diario' | 'intervalo'

export type ResultadoEnvio =
  | { status: 'enviado'; wid: string | null; avisos: MotivoBloqueio[] }
  | { status: 'adiado' | 'vetado'; motivo: MotivoBloqueio; proximaTentativa: string | null }

export type Reserva =
  | { permitido: true; id: string; esperar_ms: number }
  | { permitido: false; motivo: 'teto_diario' | 'intervalo'; proxima_tentativa?: string | null }

/** Portas do portão — injetáveis para teste determinístico. */
export interface PortaoDeps {
  modo(): ModoProtecao
  config(canal: Canal): Promise<ConfigCanal>
  optOut(ctx: ContextoEnvio): Promise<boolean>
  recentes(canal: Canal): Promise<string[]>
  reservar(args: {
    ctx: ContextoEnvio; teto: number | null; contaTeto: boolean; intervaloMs: number
    fuso: string; textoNorm: string; textoHash: string
  }): Promise<Reserva>
  confirmar(id: string, status: 'enviado' | 'falhou', motivo?: string): Promise<void>
  usadosHoje(canal: Canal, fuso: string): Promise<number>
  registrar(ctx: ContextoEnvio, status: 'vetado' | 'vetaria' | 'adiado' | 'enviado', motivo: string, textoNorm?: string, textoHash?: string): Promise<void>
  agora(): number
  rand(): number
  dormir(ms: number): Promise<void>
}

const VETO: MotivoBloqueio[] = ['opt_out', 'repeticao']
const tipoDe = (m: MotivoBloqueio): 'vetado' | 'adiado' => (VETO.includes(m) ? 'vetado' : 'adiado')

/**
 * O motivo BARRA esta origem (no modo ativo)? Manual e aviso interno nunca. Resposta da IA só por
 * opt-out: o cliente acabou de escrever, e silêncio por "repetição" ou "intervalo"
 * é pior que o risco — esses viram registro. Proativas: todos barram.
 */
export function motivoBarra(origem: OrigemEnvio, motivo: MotivoBloqueio): boolean {
  if (origem === 'manual' || origem === 'aviso_interno') return false
  if (origem === 'resposta_ia') return motivo === 'opt_out'
  return true
}

/** Lançado por `protegerEnviarTexto` quando o portão barra: nada saiu, não grave a mensagem. */
export class EnvioBarradoError extends Error {
  constructor(public readonly status: 'adiado' | 'vetado', public readonly motivo: MotivoBloqueio) {
    super(`envio ${status} pela proteção de envio: ${motivo}`)
    this.name = 'EnvioBarradoError'
  }
}

/**
 * Pré-checagem barata, SEM reservar: opt-out, janela e teto do dia. Use antes de
 * gastar uma geração de IA (follow-up) que talvez nem possa sair. Não grava nada.
 * Em modo `log`/`off` sempre libera.
 *
 * @returns `{ ok: true }` ou o motivo e se é veto (não tente de novo) ou adiamento.
 */
export async function preChecarEnvio(
  ctx: ContextoEnvio, deps: PortaoDeps = depsPadrao,
): Promise<{ ok: true } | { ok: false; status: 'adiado' | 'vetado'; motivo: MotivoBloqueio }> {
  if (deps.modo() !== 'ativo' || ctx.origem === 'manual' || ctx.origem === 'aviso_interno') return { ok: true }
  try {
    if (await deps.optOut(ctx)) return { ok: false, status: 'vetado', motivo: 'opt_out' }
    const cfg = await deps.config(ctx.canal)
    const j = avaliarJanela(cfg, ctx.origem, deps.agora())
    if (!j.ok && motivoBarra(ctx.origem, j.motivo)) return { ok: false, status: 'adiado', motivo: j.motivo }
    return { ok: true }
  } catch (e) {
    console.error('[envio/portao] pré-checagem falhou (fail-open):', e instanceof Error ? e.message : e)
    return { ok: true }
  }
}

/**
 * Envia `texto` por `enviar` só se os portões deixarem. `enviar` é o transporte
 * já escolhido pelo chamador (WAHA, Evolution, Cloud) e só é chamado uma vez.
 *
 * @returns `enviado` (com o wid e os avisos do que barraria em log/manual), ou
 *   `adiado`/`vetado` com o motivo — nesses casos NADA saiu e o chamador não deve
 *   gravar a mensagem nem contar tentativa.
 * @throws o erro do próprio transporte (ex.: janela 131047 da Meta), depois de
 *   registrar `falhou` no ledger — o chamador mantém o tratamento que já tinha.
 */
export async function enviarProtegido(
  ctx: ContextoEnvio,
  texto: string,
  enviar: () => Promise<string | null>,
  deps: PortaoDeps = depsPadrao,
): Promise<ResultadoEnvio> {
  const modo = deps.modo()
  if (modo === 'off') return { status: 'enviado', wid: await enviar(), avisos: [] }

  const barra = (m: MotivoBloqueio) => modo === 'ativo' && motivoBarra(ctx.origem, m)
  const avisos: MotivoBloqueio[] = []
  const textoNorm = normalizar(texto).slice(0, 500)
  const textoHash = createHash('sha1').update(textoNorm).digest('hex').slice(0, 16)

  let reservaId: string | null = null
  let esperar = 0
  try {
    const cfg = await deps.config(ctx.canal)
    const agora = deps.agora()

    // Portões 1–3: opt-out, janela, repetição.
    const bloqueios: MotivoBloqueio[] = []
    if (await deps.optOut(ctx)) bloqueios.push('opt_out')
    const j = avaliarJanela(cfg, ctx.origem, agora)
    if (!j.ok) bloqueios.push(j.motivo)
    if (ORIGEM_CHECA_REPETICAO[ctx.origem] && BAN_RISK[ctx.canal]) {
      const rep = avaliarRepeticao(texto, await deps.recentes(ctx.canal))
      if (rep.repetido) bloqueios.push('repeticao')
    }
    const m = bloqueios.find(barra)
    if (m) {
      await deps.registrar(ctx, tipoDe(m), m, textoNorm, textoHash)
      return { status: tipoDe(m), motivo: m, proximaTentativa: null }
    }
    for (const b of bloqueios) await deps.registrar(ctx, 'vetaria', b, undefined, textoHash)
    avisos.push(...bloqueios)

    // Portão 4: reserva atômica (teto do dia + intervalo).
    const r = await deps.reservar({
      ctx,
      teto: tetoDoDia(ctx.canal, cfg, agora),
      contaTeto: ORIGEM_PROATIVA[ctx.origem],
      intervaloMs: intervaloComJitter(ctx.canal, cfg, deps.rand()),
      fuso: cfg.fuso,
      textoNorm,
      textoHash,
    })
    if (!r.permitido) {
      if (barra(r.motivo)) return { status: 'adiado', motivo: r.motivo, proximaTentativa: r.proxima_tentativa ?? null }
      avisos.push(r.motivo)
    } else {
      reservaId = r.id
      esperar = r.esperar_ms
    }
  } catch (e) {
    console.error('[envio/portao] portão falhou (fail-open):', e instanceof Error ? e.message : e)
  }

  // Portão 5: espera do intervalo (só no modo ativo — em log o ritmo não muda).
  if (modo === 'ativo' && ctx.origem !== 'manual' && esperar > 0) await deps.dormir(Math.min(esperar, ESPERA_MAX_MS))

  try {
    const wid = await enviar()
    if (reservaId) await deps.confirmar(reservaId, 'enviado').catch(() => {})
    else await deps.registrar(ctx, 'enviado', avisos[0] ? `sem_reserva:${avisos[0]}` : 'sem_reserva', textoNorm, textoHash).catch(() => {})
    return { status: 'enviado', wid, avisos }
  } catch (e) {
    if (reservaId) {
      await deps.confirmar(reservaId, 'falhou', (e instanceof Error ? e.message : String(e)).slice(0, 200)).catch(() => {})
    }
    throw e
  }
}

/**
 * Quantos envios PROATIVOS o canal ainda pode fazer hoje (teto do dia menos o já
 * usado), ou null quando não há teto. Só barra no modo `ativo`; em log/off devolve
 * null. Para drenadores que precisam dimensionar a leva ANTES de reivindicar itens
 * (convites: devolver um item ao Arca queima uma tentativa dele). Erro = null (fail-open).
 */
export async function saldoDoDia(canal: Canal, deps: PortaoDeps = depsPadrao): Promise<number | null> {
  if (deps.modo() !== 'ativo') return null
  try {
    const cfg = await deps.config(canal)
    const teto = tetoDoDia(canal, cfg, deps.agora())
    if (teto == null) return null
    return Math.max(0, teto - (await deps.usadosHoje(canal, cfg.fuso)))
  } catch (e) {
    console.error('[envio/portao] saldo do dia falhou (fail-open):', e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Adapta um `EnviarTexto` (telefone, texto) → wid para passar pelo portão.
 * @throws {EnvioBarradoError} quando o portão barra — nada saiu; o laço de balões
 *   do chamador para ali e a mensagem não é gravada no chat como se tivesse ido.
 */
export function protegerEnviarTexto(
  base: Omit<ContextoEnvio, 'telefone'>,
  enviarTexto: (telefone: string, texto: string) => Promise<string | null>,
): (telefone: string, texto: string) => Promise<string | null> {
  return async (telefone, texto) => {
    const r = await enviarProtegido({ ...base, telefone }, texto, () => enviarTexto(telefone, texto))
    if (r.status !== 'enviado') {
      console.warn(`[envio/portao] ${r.status} (${r.motivo}) origem=${base.origem} canal=${base.canal}`)
      throw new EnvioBarradoError(r.status, r.motivo)
    }
    return r.wid
  }
}

// ── Implementação padrão das portas (Supabase, schema crm) ─────────────────────

const depsPadrao: PortaoDeps = {
  modo: modoProtecao,
  async config(canal) {
    return (await lerConfigCanal(canal)).cfg
  },
  async optOut(ctx) {
    if (!ctx.familiaId && !ctx.telefone) return false
    const supabase = createServerAdminClient()
    let q = supabase.from('familias').select('opt_out_em').not('opt_out_em', 'is', null).limit(1)
    q = ctx.familiaId ? q.eq('id', ctx.familiaId) : q.eq('telefone', ctx.telefone as string)
    const { data } = await q
    return (data?.length ?? 0) > 0
  },
  async recentes(canal) {
    const supabase = createServerAdminClient()
    const { data } = await supabase
      .from('envio_ledger')
      .select('texto_norm')
      .eq('canal', canal)
      .in('status', ['reservado', 'enviado'])
      .not('texto_norm', 'is', null)
      .gte('criado_em', new Date(Date.now() - 24 * 3600_000).toISOString())
      .order('criado_em', { ascending: false })
      .limit(REPETICAO.janela)
    return (data ?? []).map((d: { texto_norm: string }) => d.texto_norm)
  },
  async reservar(a) {
    const supabase = createServerAdminClient()
    const { data, error } = await supabase.rpc('envio_reservar', {
      p_canal: a.ctx.canal,
      p_origem: a.ctx.origem,
      p_teto: a.teto,
      p_conta_teto: a.contaTeto,
      p_intervalo_ms: a.intervaloMs,
      p_fuso: a.fuso,
      p_lead_id: a.ctx.leadId ?? null,
      p_familia_id: a.ctx.familiaId ?? null,
      p_texto_norm: a.textoNorm,
      p_texto_hash: a.textoHash,
      p_espera_max_ms: ESPERA_MAX_MS,
    })
    if (error) throw error
    return data as Reserva
  },
  async confirmar(id, status, motivo) {
    const supabase = createServerAdminClient()
    await supabase.rpc('envio_confirmar', { p_id: id, p_status: status, p_motivo: motivo ?? null })
  },
  async usadosHoje(canal, fuso) {
    const supabase = createServerAdminClient()
    const { data, error } = await supabase.rpc('envio_usados_hoje', { p_canal: canal, p_fuso: fuso })
    if (error) throw error
    return Number(data ?? 0)
  },
  async registrar(ctx, status, motivo, textoNorm, textoHash) {
    const supabase = createServerAdminClient()
    await supabase.from('envio_ledger').insert({
      canal: ctx.canal,
      origem: ctx.origem,
      status,
      motivo,
      lead_id: ctx.leadId ?? null,
      familia_id: ctx.familiaId ?? null,
      // Só uma saída real alimenta o gate de repetição.
      texto_norm: status === 'enviado' ? textoNorm ?? null : null,
      texto_hash: textoHash ?? null,
    })
  },
  agora: () => Date.now(),
  rand: () => Math.random(),
  dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
}
