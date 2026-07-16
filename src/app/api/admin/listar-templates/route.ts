import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Lista os templates de WhatsApp da conta ativa + status (APPROVED/PENDING/REJECTED),
// direto da Graph API, para o gestor acompanhar a aprovação sem sair do CRM.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const admin = createServerAdminClient()
  const { data: conta } = await admin
    .from('whatsapp_contas')
    .select('waba_id, token')
    .eq('ativo', true)
    .not('waba_id', 'is', null)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!conta?.waba_id || !conta?.token) {
    return NextResponse.json({ error: 'Conta WhatsApp ativa sem waba_id/token.' }, { status: 400 })
  }

  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${conta.waba_id}/message_templates?fields=name,status,category,language&limit=100`,
      { headers: { Authorization: `Bearer ${conta.token}` }, cache: 'no-store' }
    )
    const j = await r.json()
    if (!r.ok) {
      return NextResponse.json({ error: j?.error?.message || 'Falha ao listar templates' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, templates: j.data || [] })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'erro' }, { status: 500 })
  }
}
