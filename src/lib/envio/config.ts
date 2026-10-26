// Leitura da config por canal (crm.canal_protecao) mesclada com os defaults.
// Cache curto em memória por instância: a tela salva e invalida; outras
// instâncias pegam a mudança em até 60s.

import { createServerAdminClient } from '@/lib/supabase-server'
import { DEFAULTS, type Canal, type ConfigCanal } from './defaults'

type Linha = {
  canal: Canal
  numero_desde: string | null
  pular_aquecimento: boolean | null
  janela_resposta_ini: number | null
  janela_resposta_fim: number | null
  janela_disparo_ini: number | null
  janela_disparo_fim: number | null
  domingo_disparo: boolean | null
  intervalo_min_ms: number | null
  jitter_max_ms: number | null
  teto_diario: number | null
  fuso: string | null
  atualizado_por: string | null
  atualizado_em: string | null
}

export type ConfigEfetiva = {
  canal: Canal
  cfg: ConfigCanal
  /** Campos que vieram de override no banco (o resto é default do código). */
  sobrescritos: (keyof ConfigCanal)[]
  atualizadoPor: string | null
  atualizadoEm: string | null
}

const TTL_MS = 60_000
let cache: { em: number; porCanal: Map<Canal, ConfigEfetiva> } | null = null

export function invalidarConfigProtecao() {
  cache = null
}

/** Mescla uma linha do banco com os defaults. Exportada para teste/tela. */
export function mesclarConfig(canal: Canal, l: Partial<Linha> | null): ConfigEfetiva {
  const cfg: ConfigCanal = { ...DEFAULTS, janelaResposta: [...DEFAULTS.janelaResposta], janelaDisparo: [...DEFAULTS.janelaDisparo] }
  const sob: (keyof ConfigCanal)[] = []
  if (l) {
    if (l.numero_desde) { cfg.numeroDesde = l.numero_desde; sob.push('numeroDesde') }
    if (l.pular_aquecimento) { cfg.pularAquecimento = true; sob.push('pularAquecimento') }
    if (l.janela_resposta_ini != null && l.janela_resposta_fim != null) {
      cfg.janelaResposta = [l.janela_resposta_ini, l.janela_resposta_fim]; sob.push('janelaResposta')
    }
    if (l.janela_disparo_ini != null && l.janela_disparo_fim != null) {
      cfg.janelaDisparo = [l.janela_disparo_ini, l.janela_disparo_fim]; sob.push('janelaDisparo')
    }
    if (l.domingo_disparo != null) { cfg.domingoDisparo = l.domingo_disparo; sob.push('domingoDisparo') }
    if (l.intervalo_min_ms != null) { cfg.intervaloMinMs = l.intervalo_min_ms; sob.push('intervaloMinMs') }
    if (l.jitter_max_ms != null) { cfg.jitterMaxMs = l.jitter_max_ms; sob.push('jitterMaxMs') }
    if (l.teto_diario != null) { cfg.tetoDiario = l.teto_diario; sob.push('tetoDiario') }
    if (l.fuso) { cfg.fuso = l.fuso; sob.push('fuso') }
  }
  return { canal, cfg, sobrescritos: sob, atualizadoPor: l?.atualizado_por ?? null, atualizadoEm: l?.atualizado_em ?? null }
}

/** Config efetiva de todos os canais. Em erro de leitura, cai nos defaults (nunca derruba o envio). */
export async function lerConfigsProtecao(): Promise<Map<Canal, ConfigEfetiva>> {
  if (cache && Date.now() - cache.em < TTL_MS) return cache.porCanal
  const porCanal = new Map<Canal, ConfigEfetiva>()
  let linhas: Linha[] = []
  try {
    const supabase = createServerAdminClient()
    const { data, error } = await supabase.from('canal_protecao').select('*')
    if (error) throw error
    linhas = (data ?? []) as Linha[]
  } catch (e) {
    console.error('[envio/config] leitura falhou, usando defaults:', e instanceof Error ? e.message : e)
  }
  for (const canal of ['waha', 'evolution', 'cloud'] as Canal[]) {
    porCanal.set(canal, mesclarConfig(canal, linhas.find((l) => l.canal === canal) ?? null))
  }
  cache = { em: Date.now(), porCanal }
  return porCanal
}

export async function lerConfigCanal(canal: Canal): Promise<ConfigEfetiva> {
  return (await lerConfigsProtecao()).get(canal) ?? mesclarConfig(canal, null)
}
