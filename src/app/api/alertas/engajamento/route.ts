import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Alertas de ENGAJAMENTO (envio manual fora da janela de 24h) para a tela de
// Alertas (/pendentes). Só lista os de LEAD ATIVO e não resolvidos.
//   GET  -> lista { id, mensagem, criado_em, lead_id, familia }
//   POST { id } -> marca resolvido=true (some da tela)

type ColunaEmbed = { nome: string | null } | { nome: string | null }[] | null

function leadInativo(lead: { arquivado: boolean | null; motivo_perda: string | null; colunas: ColunaEmbed } | undefined): boolean {
  if (!lead) return false // lead não encontrado: não descarta (fail-open)
  if (lead.arquivado === true) return true
  if (lead.motivo_perda && lead.motivo_perda.trim()) return true
  const col = lead.colunas
  const nome = (Array.isArray(col) ? col[0]?.nome : col?.nome) || ''
  return /perdid/i.test(nome)
}

export async function GET() {
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const admin = createServerAdminClient()
  const { data: alertas } = await admin
    .from('alertas_sistema')
    .select('id, mensagem, criado_em, lead_id')
    .eq('tipo', 'engajamento')
    .eq('resolvido', false)
    .order('criado_em', { ascending: false })
    .limit(100)

  const lista = alertas ?? []
  const leadIds = [...new Set(lista.map((a) => a.lead_id).filter(Boolean))] as string[]

  type LeadRow = {
    id: string
    arquivado: boolean | null
    motivo_perda: string | null
    colunas: ColunaEmbed
    familia: { nome_responsavel: string | null; telefone: string | null } | { nome_responsavel: string | null; telefone: string | null }[] | null
  }
  let leadMap = new Map<string, LeadRow>()
  if (leadIds.length) {
    const { data: leads } = await admin
      .from('leads')
      .select('id, arquivado, motivo_perda, colunas(nome), familia:familias(nome_responsavel, telefone)')
      .in('id', leadIds)
    leadMap = new Map(((leads as LeadRow[]) ?? []).map((l) => [l.id, l]))
  }

  const items = lista
    .filter((a) => {
      if (!a.lead_id) return true
      return !leadInativo(leadMap.get(a.lead_id))
    })
    .map((a) => {
      const l = a.lead_id ? leadMap.get(a.lead_id) : undefined
      const famEmbed = l?.familia
      const familia = Array.isArray(famEmbed) ? famEmbed[0] : famEmbed
      return {
        id: a.id,
        mensagem: a.mensagem,
        criado_em: a.criado_em,
        lead_id: a.lead_id,
        familia: familia ?? null,
      }
    })

  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const admin = createServerAdminClient()
  const { error } = await admin.from('alertas_sistema').update({ resolvido: true }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
