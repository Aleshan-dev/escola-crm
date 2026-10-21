/**
 * Versionamento da configuração da Sara e do Salomão — regras PURAS (sem banco).
 *
 * Padrão DeskcommCRM: editar grava RASCUNHO, testar usa o rascunho sem enviar,
 * PUBLICAR cria vN e reflete em config_ia (função SQL crm.publicar_agente_versao).
 * O snapshot usa os nomes das colunas de config_ia como chaves — a lista abaixo
 * TEM que bater com o mapeamento da função SQL (docs/sql/2026-10-21-agente-versoes.sql).
 *
 * salomao_ativo fica de fora de propósito: é kill switch, efeito imediato.
 */

export type Agente = 'sara' | 'salomao'
export const AGENTES: readonly Agente[] = ['sara', 'salomao']

type TipoCampo = 'texto' | 'bool' | 'uuid'

export const CAMPOS_VERSIONADOS: Record<Agente, Record<string, TipoCampo>> = {
  sara: {
    nome_agente: 'texto',
    modelo: 'texto',
    informa_preco: 'bool',
    system_prompt: 'texto',
    sara_credencial_id: 'uuid',
  },
  salomao: {
    salomao_modelo: 'texto',
    salomao_system_prompt: 'texto',
    salomao_canais_pagamento: 'texto',
    salomao_credencial_id: 'uuid',
  },
}

/** Rótulos para histórico/diff. */
export const ROTULOS: Record<string, string> = {
  nome_agente: 'Nome do agente',
  modelo: 'Modelo',
  informa_preco: 'Informa preço',
  system_prompt: 'Prompt do sistema',
  sara_credencial_id: 'Credencial de IA',
  salomao_modelo: 'Modelo',
  salomao_system_prompt: 'Preâmbulo de persona',
  salomao_canais_pagamento: 'Canais de pagamento',
  salomao_credencial_id: 'Credencial de IA',
}

export type Snapshot = Record<string, string | boolean | null>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ehAgente(v: unknown): v is Agente {
  return v === 'sara' || v === 'salomao'
}

/**
 * Mantém só os campos versionados do agente, com o tipo certo. Texto vazio vira
 * null (igual às telas antigas); prompt da Sara NÃO é trimado por dentro — só
 * vazio vira null — para não alterar formatação intencional.
 */
export function normalizarSnapshot(agente: Agente, raw: unknown): Snapshot {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: Snapshot = {}
  for (const [campo, tipo] of Object.entries(CAMPOS_VERSIONADOS[agente])) {
    const v = src[campo]
    if (tipo === 'bool') {
      out[campo] = v === true
    } else if (tipo === 'uuid') {
      out[campo] = typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null
    } else {
      out[campo] = typeof v === 'string' && v.trim() ? (campo.endsWith('system_prompt') ? v : v.trim()) : null
    }
  }
  return out
}

/** Extrai o snapshot vigente de uma linha de config_ia. */
export function snapshotDeConfig(agente: Agente, cfg: Record<string, unknown> | null | undefined): Snapshot {
  return normalizarSnapshot(agente, cfg ?? {})
}

export interface DiffCampo {
  campo: string
  rotulo: string
  antes: string | boolean | null
  depois: string | boolean | null
}

/** Campos que mudaram de `a` para `b` (ambos normalizados antes de comparar). */
export function diffSnapshots(agente: Agente, a: unknown, b: unknown): DiffCampo[] {
  const na = normalizarSnapshot(agente, a)
  const nb = normalizarSnapshot(agente, b)
  return Object.keys(CAMPOS_VERSIONADOS[agente])
    .filter((c) => na[c] !== nb[c])
    .map((c) => ({ campo: c, rotulo: ROTULOS[c] ?? c, antes: na[c], depois: nb[c] }))
}

export function snapshotsIguais(agente: Agente, a: unknown, b: unknown): boolean {
  return diffSnapshots(agente, a, b).length === 0
}

/**
 * Aplica um patch parcial (ex.: proposta do Maestro trocando só o prompt) sobre
 * uma base, devolvendo o snapshot normalizado. Chaves fora da allowlist do
 * agente são ignoradas.
 */
export function aplicarPatch(agente: Agente, base: unknown, patch: Record<string, unknown>): Snapshot {
  const b = normalizarSnapshot(agente, base)
  const permitido = CAMPOS_VERSIONADOS[agente]
  const filtrado = Object.fromEntries(Object.entries(patch).filter(([k]) => k in permitido))
  return normalizarSnapshot(agente, { ...b, ...filtrado })
}

export type LinhaDiff = { tipo: 'igual' | 'add' | 'del'; texto: string }

/**
 * Diff simples por linha (LCS). Suficiente para prompts de algumas centenas de
 * linhas; acima de LIMITE células cai num diff "tudo saiu / tudo entrou" para
 * não travar o navegador.
 */
export function diffLinhas(antes: string | null, depois: string | null, limite = 400_000): LinhaDiff[] {
  const a = (antes ?? '').split('\n')
  const b = (depois ?? '').split('\n')
  if (antes === depois) return a.map((t) => ({ tipo: 'igual', texto: t }))
  if (a.length * b.length > limite) {
    return [...a.map((t) => ({ tipo: 'del' as const, texto: t })), ...b.map((t) => ({ tipo: 'add' as const, texto: t }))]
  }
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: LinhaDiff[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ tipo: 'igual', texto: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ tipo: 'del', texto: a[i] }); i++ }
    else { out.push({ tipo: 'add', texto: b[j] }); j++ }
  }
  while (i < n) out.push({ tipo: 'del', texto: a[i++] })
  while (j < m) out.push({ tipo: 'add', texto: b[j++] })
  return out
}

export interface VersaoResumo {
  status: 'rascunho' | 'publicada' | 'arquivada'
  snapshot: unknown
}

/**
 * O que a tela deve mostrar no editor: o rascunho (se houver) ou a publicada.
 * `pendente` = existe rascunho diferente do que está no ar.
 */
export function estadoEditor(
  agente: Agente,
  publicada: VersaoResumo | null,
  rascunho: VersaoResumo | null,
  configAtual: Record<string, unknown> | null,
): { snapshot: Snapshot; pendente: boolean; noAr: Snapshot } {
  // config_ia é a verdade do que está no ar (a publicada deveria ser igual).
  const noAr = configAtual ? snapshotDeConfig(agente, configAtual) : normalizarSnapshot(agente, publicada?.snapshot)
  if (rascunho) {
    const snap = normalizarSnapshot(agente, rascunho.snapshot)
    return { snapshot: snap, pendente: !snapshotsIguais(agente, snap, noAr), noAr }
  }
  return { snapshot: noAr, pendente: false, noAr }
}
