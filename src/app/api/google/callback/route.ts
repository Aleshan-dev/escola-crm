import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'

const REDIRECT = 'https://escola-crm.vercel.app/api/google/callback'
const VOLTA = 'https://escola-crm.vercel.app/configuracoes/integracoes'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.redirect(`${VOLTA}?erro=sem_codigo`)

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: '399470356836-r0kgrpnv5vutp8fsq263sa4kcafv9b4m.apps.googleusercontent.com',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  })
  const tok = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!tok.access_token) return NextResponse.redirect(`${VOLTA}?erro=token`)

  const registro: Record<string, unknown> = {
    id: 1,
    access_token: tok.access_token,
    expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }
  if (tok.refresh_token) registro.refresh_token = tok.refresh_token

  const supabase = createServerAdminClient()
  await supabase.from('integracao_google').upsert(registro)

  return NextResponse.redirect(`${VOLTA}?ok=1`)
}
