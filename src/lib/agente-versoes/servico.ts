/**
 * Versionamento da configuração dos agentes — acesso ao banco (crm.agente_versoes).
 * Regras puras em ./regras.ts; publicação atômica na função SQL
 * crm.publicar_agente_versao (arquiva a anterior + reflete em config_ia).
 */
import { createServerAdminClient } from '@/lib/supabase-server'
import { aplicarPatch, estadoEditor, normalizarSnapshot, snapshotsIguais, type Agente, type Snapshot } from './regras'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export type Origem = 'tela' | 'maestro' | 'restauracao' | 'baseline'

export interface Versao {
  id: string
  agente: Agente
  versao: number | null
  snapshot: Snapshot
  status: 'rascunho' | 'publicada' | 'arquivada'
  origem: Origem
  nota: string | null
  base_versao: number | null
  criado_por: string | null
  criado_em: string
  atualizado_em: string
  publicado_por: string | null
  publicado_em: string | null
}

export interface EstadoAgente {
  versoes: Versao[]
  rascunho: Versao | null
  publicada: Versao | null
  editor: Snapshot
  noAr: Snapshot
  pendente: boolean
}

export async function carregarEstado(agente: Agente, db: SupaAdmin = createServerAdminClient()): Promise<EstadoAgente> {
  const [vResp, cResp] = await Promise.all([
    db.from('agente_versoes').select('*').eq('agente', agente).order('criado_em', { ascending: false }).limit(100),
    db.from('config_ia').select('*').eq('id', 1).maybeSingle(),
  ])
  if (vResp.error) throw new Error(vResp.error.message)
  const versoes = (vResp.data ?? []) as Versao[]
  const rascunho = versoes.find((v) => v.status === 'rascunho') ?? null
  const publicada = versoes.find((v) => v.status === 'publicada') ?? null
  const e = estadoEditor(agente, publicada, rascunho, (cResp.data ?? null) as Record<string, unknown> | null)
  // Histórico: publicadas/arquivadas por número de versão (mais nova primeiro).
  const historico = versoes
    .filter((v) => v.status !== 'rascunho')
    .sort((a, b) => (b.versao ?? 0) - (a.versao ?? 0))
  return { versoes: historico, rascunho, publicada, editor: e.snapshot, noAr: e.noAr, pendente: e.pendente }
}

/** Cria ou sobrescreve o rascunho do agente (há no máximo um). Não toca config_ia. */
export async function salvarRascunho(
  agente: Agente,
  snapshotBruto: unknown,
  opts: { origem?: Origem; por?: string | null; nota?: string | null; baseVersao?: number | null } = {},
  db: SupaAdmin = createServerAdminClient(),
): Promise<Versao> {
  const snapshot = normalizarSnapshot(agente, snapshotBruto)
  const agora = new Date().toISOString()
  const { data: atual } = await db
    .from('agente_versoes').select('id').eq('agente', agente).eq('status', 'rascunho').maybeSingle()

  if (atual) {
    const { data, error } = await db
      .from('agente_versoes')
      .update({
        snapshot, origem: opts.origem ?? 'tela', nota: opts.nota ?? null, base_versao: opts.baseVersao ?? null,
        criado_por: opts.por ?? null, atualizado_em: agora,
      })
      .eq('id', (atual as { id: string }).id)
      .select('*')
      .single()
    if (error) throw new Error(error.message)
    return data as Versao
  }

  const { data: pub } = await db
    .from('agente_versoes').select('versao').eq('agente', agente).eq('status', 'publicada').maybeSingle()
  const { data, error } = await db
    .from('agente_versoes')
    .insert({
      agente, snapshot, status: 'rascunho', origem: opts.origem ?? 'tela', nota: opts.nota ?? null,
      base_versao: opts.baseVersao ?? (pub as { versao: number } | null)?.versao ?? null, criado_por: opts.por ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  return data as Versao
}

/**
 * Maestro: aplica um patch parcial sobre o rascunho atual (ou sobre o que está
 * no ar, se não houver rascunho) e grava como rascunho. Nunca publica.
 */
export async function rascunhoComPatch(
  agente: Agente,
  patch: Record<string, unknown>,
  opts: { origem?: Origem; por?: string | null; nota?: string | null } = {},
  db: SupaAdmin = createServerAdminClient(),
): Promise<Versao> {
  const estado = await carregarEstado(agente, db)
  const novo = aplicarPatch(agente, estado.editor, patch)
  return salvarRascunho(agente, novo, { ...opts, baseVersao: estado.publicada?.versao ?? null }, db)
}

export async function descartarRascunho(agente: Agente, db: SupaAdmin = createServerAdminClient()): Promise<void> {
  const { error } = await db.from('agente_versoes').delete().eq('agente', agente).eq('status', 'rascunho')
  if (error) throw new Error(error.message)
}

/** Publica o rascunho atual. Falha se não houver rascunho ou se ele for igual ao que está no ar. */
export async function publicarRascunho(
  agente: Agente,
  opts: { por?: string | null; nota?: string | null } = {},
  db: SupaAdmin = createServerAdminClient(),
): Promise<Versao> {
  const estado = await carregarEstado(agente, db)
  if (!estado.rascunho) throw new Error('Não há rascunho para publicar.')
  if (snapshotsIguais(agente, estado.rascunho.snapshot, estado.noAr)) {
    throw new Error('O rascunho é igual ao que já está no ar.')
  }
  const { data, error } = await db.rpc('publicar_agente_versao', {
    p_agente: agente, p_id: estado.rascunho.id, p_por: opts.por ?? null, p_nota: opts.nota?.trim() || null,
  })
  if (error) throw new Error(error.message)
  return data as Versao
}

/**
 * Rollback: publica de novo o snapshot de uma versão antiga, como vN+1
 * (o histórico nunca é reescrito). O rascunho em andamento, se houver, fica.
 */
export async function restaurarVersao(
  agente: Agente,
  versaoId: string,
  opts: { por?: string | null } = {},
  db: SupaAdmin = createServerAdminClient(),
): Promise<Versao> {
  const { data: alvo } = await db
    .from('agente_versoes').select('*').eq('id', versaoId).eq('agente', agente).maybeSingle()
  const v = alvo as Versao | null
  if (!v || v.status === 'rascunho' || v.versao == null) throw new Error('Versão não encontrada.')
  if (v.status === 'publicada') throw new Error('Esta versão já é a que está no ar.')
  const { data, error } = await db.rpc('publicar_agente_versao', {
    p_agente: agente, p_snapshot: normalizarSnapshot(agente, v.snapshot), p_por: opts.por ?? null,
    p_nota: `Restauração da v${v.versao}`, p_base_versao: v.versao,
  })
  if (error) throw new Error(error.message)
  return data as Versao
}
