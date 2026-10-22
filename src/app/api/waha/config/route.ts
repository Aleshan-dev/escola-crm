import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { invalidarWahaConfig } from '@/lib/waha'

// Leitura/gravação das credenciais WAHA (crm.integracao_waha).
// Protegida pela sessão (middleware). A api_key NUNCA volta ao cliente — o GET
// só diz se ela está preenchida. Escrita/leitura via service role (a tabela tem
// RLS ligada e sem policies).

export const dynamic = 'force-dynamic'

type Row = { api_url: string | null; api_key: string | null; session: string | null }

export async function GET() {
  const supabase = createServerAdminClient()
  const { data } = await supabase
    .from('integracao_waha')
    .select('api_url, api_key, session')
    .eq('id', 1)
    .maybeSingle<Row>()

  return NextResponse.json({
    api_url: data?.api_url || '',
    session: data?.session || 'default',
    tem_key: !!data?.api_key,
    // Fallback de env disponível (informativo para a UI).
    env_url: !!process.env.WAHA_API_URL,
    env_key: !!process.env.WAHA_API_KEY,
  })
}

export async function POST(req: NextRequest) {
  let body: { api_url?: string; api_key?: string; session?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ erro: 'json inválido' }, { status: 400 })
  }

  const api_url = (body.api_url || '').trim().replace(/\/+$/, '')
  const session = (body.session || 'default').trim() || 'default'
  // api_key vazia = manter a existente (permite editar URL/sessão sem redigitar).
  const api_key = typeof body.api_key === 'string' ? body.api_key.trim() : ''

  const supabase = createServerAdminClient()

  const patch: Record<string, unknown> = { api_url, session, atualizado_em: new Date().toISOString() }
  if (api_key) patch.api_key = api_key

  const { error } = await supabase.from('integracao_waha').update(patch).eq('id', 1)
  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 })
  }

  invalidarWahaConfig()
  return NextResponse.json({ ok: true })
}
