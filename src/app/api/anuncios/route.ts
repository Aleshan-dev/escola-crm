import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { buscarInsightsAnuncios } from '@/lib/meta-ads'

// Acompanhamento por anúncio: cruza o funil real do CRM (leads meta-ads agrupados por
// ad_id, com fallback na campanha) com o gasto vindo da API do Meta. GET lê; POST salva
// as credenciais do Meta (token/conta) em config_ia — o token nunca volta ao cliente.

export const dynamic = 'force-dynamic'

type LeadRow = {
  familia_id: string
  cog_interesse: number | null
  temperatura: string | null
  crianca_id: string | null
  visita_agendada_em: string | null
  visita_realizada_em: string | null
  convertido_em: string | null
  arquivado: boolean | null
}

type FamRow = {
  id: string
  ad_id: string | null
  campanha: string | null
  referral: Record<string, unknown> | null
  criado_em: string
}

type Grupo = {
  chave: string
  adId: string | null
  campanha: string | null
  titulo: string | null
  thumbnail: string | null
  leads: number
  qualificados: number
  visitasAgendadas: number
  visitasRealizadas: number
  matriculas: number
  quentes: number
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function GET(req: NextRequest) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const dias = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('dias') || '180', 10) || 180, 1), 730)
  const until = new Date()
  const since = new Date(until.getTime() - dias * 24 * 60 * 60 * 1000)
  const db = createServerAdminClient()

  // 1) Famílias que chegaram por anúncio na janela
  const { data: famsRaw, error: errFam } = await db
    .from('familias')
    .select('id, ad_id, campanha, referral, criado_em')
    .eq('canal', 'meta-ads')
    .gte('criado_em', since.toISOString())
  if (errFam) return NextResponse.json({ error: errFam.message }, { status: 500 })
  const fams = (famsRaw || []) as FamRow[]

  // 2) Leads dessas famílias
  const famIds = fams.map((f) => f.id)
  let leads: LeadRow[] = []
  if (famIds.length) {
    const { data: leadsRaw, error: errLeads } = await db
      .from('leads')
      .select(
        'familia_id, cog_interesse, temperatura, crianca_id, visita_agendada_em, visita_realizada_em, convertido_em, arquivado'
      )
      .in('familia_id', famIds)
    if (errLeads) return NextResponse.json({ error: errLeads.message }, { status: 500 })
    leads = (leadsRaw || []) as LeadRow[]
  }
  const leadsPorFamilia = new Map<string, LeadRow[]>()
  for (const l of leads) {
    const arr = leadsPorFamilia.get(l.familia_id) || []
    arr.push(l)
    leadsPorFamilia.set(l.familia_id, arr)
  }

  // 3) Agrupa por anúncio (ad_id) com fallback na campanha
  const grupos = new Map<string, Grupo>()
  for (const f of fams) {
    const chave = f.ad_id ? `ad:${f.ad_id}` : `camp:${(f.campanha || 'sem-campanha').toLowerCase()}`
    let g = grupos.get(chave)
    if (!g) {
      const ref = f.referral || {}
      g = {
        chave,
        adId: f.ad_id,
        campanha: f.campanha,
        titulo: (ref['title'] as string) || null,
        thumbnail: (ref['thumbnailURL'] as string) || (ref['thumbnail'] as string) || null,
        leads: 0,
        qualificados: 0,
        visitasAgendadas: 0,
        visitasRealizadas: 0,
        matriculas: 0,
        quentes: 0,
      }
      grupos.set(chave, g)
    }
    const dosLeads = leadsPorFamilia.get(f.id) || []
    // Uma família = um contato (uma conversa). Usa o lead mais relevante da família.
    const lead =
      dosLeads.find((l) => l.convertido_em) ||
      dosLeads.find((l) => l.visita_realizada_em) ||
      dosLeads.find((l) => l.visita_agendada_em) ||
      dosLeads[0] ||
      null
    g.leads += 1
    if (lead) {
      const qualificado = !!lead.crianca_id || (lead.cog_interesse ?? 0) >= 3
      if (qualificado) g.qualificados += 1
      if (lead.temperatura === 'quente') g.quentes += 1
      if (lead.visita_agendada_em) g.visitasAgendadas += 1
      if (lead.visita_realizada_em) g.visitasRealizadas += 1
      if (lead.convertido_em) g.matriculas += 1
    }
  }

  // 4) Gasto por anúncio. Fonte primária: snapshot crm.anuncio_insights, escrito pela
  // tarefa diária (puxa do Meta pela conexão do Claude) — dispensa token no app. Só se o
  // snapshot estiver vazio tentamos a API ao vivo (quando houver token configurado).
  type Insight = { spend: number; impressions: number | null; cpm: number | null; ctr: number | null; conversas: number | null }
  const adIds = Array.from(grupos.values()).map((g) => g.adId).filter((x): x is string => !!x)
  const porAd = new Map<string, Insight>()
  let atualizadoEm: string | null = null

  if (adIds.length) {
    const { data: snapRows } = await db
      .from('anuncio_insights')
      .select('ad_id, spend, impressions, cpm, ctr, conversas, atualizado_em')
      .in('ad_id', adIds)
    for (const r of (snapRows || []) as Record<string, unknown>[]) {
      porAd.set(String(r.ad_id), {
        spend: Number(r.spend ?? 0),
        impressions: r.impressions != null ? Number(r.impressions) : null,
        cpm: r.cpm != null ? Number(r.cpm) : null,
        ctr: r.ctr != null ? Number(r.ctr) : null,
        conversas: r.conversas != null ? Number(r.conversas) : null,
      })
      const ts = r.atualizado_em ? String(r.atualizado_em) : null
      if (ts && (!atualizadoEm || ts > atualizadoEm)) atualizadoEm = ts
    }
  }

  let metaOk = porAd.size > 0
  let metaErro: string | null = metaOk ? null : 'Sem snapshot de gasto ainda — a atualização diária ou o token do Meta preenchem aqui.'
  if (porAd.size === 0) {
    const live = await buscarInsightsAnuncios({ since: ymd(since), until: ymd(until) })
    if (live.ok) {
      for (const [id, v] of Object.entries(live.porAd)) {
        porAd.set(id, { spend: v.spend, impressions: v.impressions, cpm: v.cpm, ctr: v.ctr, conversas: v.conversas })
      }
      metaOk = true
      metaErro = null
    } else {
      metaErro = live.motivo
    }
  }

  const linhas = Array.from(grupos.values()).map((g) => {
    const insight = g.adId ? porAd.get(g.adId) : undefined
    const spend = insight?.spend ?? null
    const custo = (q: number) => (spend != null && q > 0 ? Number((spend / q).toFixed(2)) : null)
    return {
      ...g,
      spend,
      impressions: insight?.impressions ?? null,
      cpm: insight?.cpm ?? null,
      ctr: insight?.ctr ?? null,
      conversasMeta: insight?.conversas ?? null,
      custoPorLead: custo(g.leads),
      custoPorVisita: custo(g.visitasAgendadas),
      custoPorMatricula: custo(g.matriculas),
    }
  })
  // Com gasto na frente (mais caro primeiro); depois os sem gasto, por volume de leads.
  linhas.sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || b.leads - a.leads)

  return NextResponse.json({
    dias,
    desde: ymd(since),
    ate: ymd(until),
    metaOk,
    metaErro,
    atualizadoEm,
    linhas,
  })
}

export async function POST(req: NextRequest) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { token?: string; accountId?: string }
  const patch: Record<string, string> = {}
  if (typeof body.token === 'string' && body.token.trim()) patch.meta_ads_token = body.token.trim()
  if (typeof body.accountId === 'string') patch.meta_ads_account_id = body.accountId.trim()
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nada para salvar.' }, { status: 400 })
  }

  const db = createServerAdminClient()
  const { error } = await db.from('config_ia').update(patch).eq('id', 1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
