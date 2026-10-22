import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { validarCredencial, PROVEDORES_VALIDOS, type Provedor } from '@/lib/ia-credenciais'

// Credenciais de IA: a chave é SECRETA e só trafega no servidor (service role).
// O browser nunca recebe `api_key` — só provedor/nome/ultimos4/status.
// Protegido por sessão pelo middleware (não é /api/webhook|cron|admin).

const SAFE = 'id, provedor, nome, ultimos4, validada, erro_validacao, criado_em'

export async function GET() {
  const db = createServerAdminClient()
  const { data, error } = await db.from('ia_credenciais').select(SAFE).order('criado_em', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const { data: cfg } = await db.from('config_ia').select('sara_credencial_id, salomao_credencial_id').eq('id', 1).maybeSingle()
  const uso = (id: string) =>
    (cfg?.sara_credencial_id === id ? 1 : 0) + (cfg?.salomao_credencial_id === id ? 1 : 0)
  return NextResponse.json({ credenciais: (data || []).map((c) => ({ ...c, em_uso_por: uso(c.id) })) })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const provedor = body?.provedor as Provedor
  const api_key = String(body?.api_key ?? '').trim()
  const nome = String(body?.nome ?? '').trim() || null
  const base_url = String(body?.base_url ?? '').trim() || null

  if (!PROVEDORES_VALIDOS.includes(provedor)) return NextResponse.json({ error: 'Provedor inválido' }, { status: 400 })
  if (!api_key) return NextResponse.json({ error: 'Informe a chave' }, { status: 400 })
  if (provedor === 'custom' && !base_url) return NextResponse.json({ error: 'Informe a baseURL do provedor custom' }, { status: 400 })

  const v = await validarCredencial(provedor, api_key, base_url)
  const db = createServerAdminClient()
  const { data, error } = await db
    .from('ia_credenciais')
    .insert({ provedor, nome, api_key, base_url, ultimos4: api_key.slice(-4), validada: v.ok, erro_validacao: v.erro ?? null })
    .select(SAFE)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ credencial: { ...data, em_uso_por: 0 } })
}
