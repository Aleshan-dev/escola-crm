// Gasto/entrega dos anúncios via API de Marketing do Meta (Graph API), por ANÚNCIO.
// Server-only: o token vive em config_ia (meta_ads_token) e NUNCA vai ao navegador.
// Usado pelo acompanhamento de anúncios (/api/anuncios + /anuncios).
//
// Defensivo por decisão de produto: qualquer falha (sem token, Graph fora, conta sem
// permissão) devolve { ok:false, motivo } — a tela mostra o funil de leads mesmo assim
// e sinaliza "gasto indisponível", em vez de quebrar.

import { createServerAdminClient } from '@/lib/supabase-server'

const GRAPH = 'https://graph.facebook.com/v21.0'

export type MetaAdInsight = {
  adId: string
  nome: string | null
  spend: number
  impressions: number
  reach: number
  cpm: number | null
  ctr: number | null
  /** Conversas iniciadas por mensagem (objetivo do anúncio) — para casar com o CRM. */
  conversas: number
}

export type MetaAdsResult =
  | { ok: true; porAd: Record<string, MetaAdInsight> }
  | { ok: false; motivo: string }

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : 0
  return Number.isNaN(n) ? 0 : n
}

function somarAcoes(
  actions: { action_type: string; value: string }[] | undefined,
  tipos: string[]
): number {
  if (!Array.isArray(actions)) return 0
  return actions
    .filter((a) => tipos.includes(a.action_type))
    .reduce((s, a) => s + num(a.value), 0)
}

/**
 * Lê token + conta de config_ia (id=1) e busca insights por anúncio na janela dada
 * (ou lifetime, se nenhuma). Retorna um mapa ad_id -> métricas.
 */
export async function buscarInsightsAnuncios(opts?: {
  since?: string // YYYY-MM-DD
  until?: string // YYYY-MM-DD
}): Promise<MetaAdsResult> {
  const supabase = createServerAdminClient()
  const { data } = await supabase
    .from('config_ia')
    .select('meta_ads_token, meta_ads_account_id')
    .eq('id', 1)
    .maybeSingle<{ meta_ads_token: string | null; meta_ads_account_id: string | null }>()

  const token = data?.meta_ads_token?.trim()
  const conta = data?.meta_ads_account_id?.trim()
  if (!token) return { ok: false, motivo: 'Token da API do Meta não configurado.' }
  if (!conta) return { ok: false, motivo: 'Conta de anúncios do Meta não configurada.' }

  const acct = conta.startsWith('act_') ? conta : `act_${conta}`
  const janela =
    opts?.since && opts?.until
      ? `&time_range=${encodeURIComponent(JSON.stringify({ since: opts.since, until: opts.until }))}`
      : '&date_preset=maximum'
  const fields = 'ad_id,ad_name,spend,impressions,reach,cpm,ctr,actions'
  let next: string | null = `${GRAPH}/${acct}/insights?level=ad&fields=${fields}&limit=500${janela}`

  try {
    const porAd: Record<string, MetaAdInsight> = {}
    let guard = 0
    while (next && guard++ < 25) {
      const r = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) {
        const t = await r.text()
        return { ok: false, motivo: `Graph ${r.status}: ${t.slice(0, 200)}` }
      }
      const j = (await r.json()) as {
        data?: Record<string, unknown>[]
        paging?: { next?: string }
      }
      for (const row of j.data ?? []) {
        const adId = String(row.ad_id ?? '')
        if (!adId) continue
        porAd[adId] = {
          adId,
          nome: (row.ad_name as string) ?? null,
          spend: num(row.spend),
          impressions: num(row.impressions),
          reach: num(row.reach),
          cpm: row.cpm != null ? num(row.cpm) : null,
          ctr: row.ctr != null ? num(row.ctr) : null,
          conversas: somarAcoes(
            row.actions as { action_type: string; value: string }[] | undefined,
            [
              'onsite_conversion.messaging_conversation_started_7d',
              'onsite_conversion.total_messaging_connection',
            ]
          ),
        }
      }
      next = j.paging?.next ?? null
    }
    return { ok: true, porAd }
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : 'Falha ao consultar a API do Meta.' }
  }
}
