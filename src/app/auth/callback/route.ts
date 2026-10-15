import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// Callback do login OAuth (Google) via Supabase Auth (fluxo PKCE do @supabase/ssr).
// O Supabase redireciona para cá com ?code=...; trocamos o code pela sessão
// (grava os cookies) e mandamos o usuário para o destino.
// Versão instrumentada: em caso de falha, devolve o motivo exato em ?error=...
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/kanban'
  const providerError = searchParams.get('error_description') || searchParams.get('error')

  if (providerError) {
    console.error('[auth/callback] provider error:', providerError)
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('provider: ' + providerError)}`)
  }

  if (!code) {
    console.error('[auth/callback] sem code na URL de retorno')
    return NextResponse.redirect(`${origin}/login?error=sem_code`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (!error) {
    return NextResponse.redirect(`${origin}${next}`)
  }

  console.error('[auth/callback] exchange falhou:', error.message)
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('troca: ' + error.message)}`)
}
