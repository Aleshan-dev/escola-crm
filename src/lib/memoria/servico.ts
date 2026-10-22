/**
 * MEMÓRIA DO LEAD — serviço (I/O). Toda escrita passa pela RPC crm.memoria_salvar
 * (lock por lead + dedupe por título + substituição que arquiva + orçamento), então
 * Sara, Salomão, extração e equipe podem gravar em paralelo sem estourar o limite.
 * Logs levam só ids e motivos, nunca o conteúdo das notas (dado pessoal).
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import { ORCAMENTO_PADRAO, indexarNotas, type NotaMemoria, type OrigemMemoria, type PedidoMemoria } from './regras'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export interface ConfigMemoria {
  ativa: boolean
  orcamento: number
}

export async function lerConfigMemoria(supabase: SupaAdmin): Promise<ConfigMemoria> {
  const { data } = await supabase
    .from('config_ia')
    .select('memoria_ativa, memoria_orcamento_chars')
    .eq('id', 1)
    .maybeSingle()
  return {
    ativa: data?.memoria_ativa !== false,
    orcamento: data?.memoria_orcamento_chars ?? ORCAMENTO_PADRAO,
  }
}

const COLUNAS = 'id, titulo, corpo, origem, criado_em, atualizado_em'

/** Notas ativas do lead, mais o mapa M#→uuid que o prompt usa. */
export async function carregarMemoria(
  supabase: SupaAdmin,
  leadId: string
): Promise<{ notas: NotaMemoria[]; mapa: Record<string, string> }> {
  const { data, error } = await supabase
    .from('memoria_lead')
    .select(COLUNAS)
    .eq('lead_id', leadId)
    .is('arquivada_em', null)
    .order('criado_em')
  if (error) {
    console.error('[memoria] leitura falhou', leadId, error.message)
    return { notas: [], mapa: {} }
  }
  const notas = (data ?? []) as NotaMemoria[]
  return { notas, mapa: indexarNotas(notas).mapa }
}

export type ResultadoSalvar = { ok: true; id: string } | { ok: false; motivo: string }

export async function salvarNota(
  supabase: SupaAdmin,
  args: {
    leadId: string
    titulo: string
    corpo: string
    origem: OrigemMemoria
    orcamento: number
    autorId?: string | null
    substitui?: string[]
    notaId?: string | null
  }
): Promise<ResultadoSalvar> {
  const { data, error } = await supabase.rpc('memoria_salvar', {
    p_lead_id: args.leadId,
    p_titulo: args.titulo,
    p_corpo: args.corpo,
    p_origem: args.origem,
    p_autor_id: args.autorId ?? null,
    p_substitui: args.substitui ?? [],
    p_orcamento: args.orcamento,
    p_nota_id: args.notaId ?? null,
  })
  if (error) return { ok: false, motivo: error.message }
  const r = data as { ok: boolean; id?: string; motivo?: string } | null
  return r?.ok && r.id ? { ok: true, id: r.id } : { ok: false, motivo: r?.motivo ?? 'desconhecido' }
}

/** Arquiva (não apaga) — a equipe pode ver as arquivadas no histórico. */
export async function arquivarNota(supabase: SupaAdmin, leadId: string, notaId: string): Promise<boolean> {
  const { data } = await supabase
    .from('memoria_lead')
    .update({ arquivada_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
    .eq('id', notaId)
    .eq('lead_id', leadId)
    .is('arquivada_em', null)
    .select('id')
  return !!data?.length
}

/**
 * Efeito de memória de um turno (Sara/Salomão), depois do envio. Nunca lança:
 * memória é acessória e não pode derrubar o atendimento.
 */
export async function aplicarMemoriaDoTurno(
  supabase: SupaAdmin,
  args: { leadId: string; origem: OrigemMemoria; pedidos: PedidoMemoria[] }
): Promise<void> {
  if (!args.pedidos.length) return
  try {
    const cfg = await lerConfigMemoria(supabase)
    if (!cfg.ativa) return
    for (const p of args.pedidos) {
      const r = await salvarNota(supabase, {
        leadId: args.leadId, titulo: p.titulo, corpo: p.corpo, origem: args.origem,
        substitui: p.substitui, orcamento: cfg.orcamento,
      })
      if (!r.ok) console.warn(`[memoria] ${args.origem} não gravou nota (lead ${args.leadId}): ${r.motivo}`)
    }
  } catch (e) {
    console.error('[memoria] falha ao aplicar memória do turno', args.leadId, e instanceof Error ? e.message : e)
  }
}
