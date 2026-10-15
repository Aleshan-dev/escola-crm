import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const url = request.nextUrl
  const isAuthRoute = url.pathname.startsWith('/login')
  // Callback do OAuth (Google): precisa passar sem exigir sessão, pois ela
  // ainda vai ser criada dentro da rota /auth/callback.
  const isAuthCallback = url.pathname.startsWith('/auth')
  // Rotas de API que fazem a própria autenticação (webhooks, cron e admin protegido por CRON_SECRET/sessão)
  const isApiWebhook =
    url.pathname.startsWith('/api/webhook') ||
    url.pathname.startsWith('/api/cron') ||
    url.pathname.startsWith('/api/admin')
  const isPublic = url.pathname.startsWith('/privacy') || url.pathname.startsWith('/termos')

  // Webhooks do WhatsApp não precisam de auth
  if (isApiWebhook) return supabaseResponse

  // Deixa o callback do OAuth (Google) completar a troca do code pela sessão
  if (isAuthCallback) return supabaseResponse

  // Não logado → manda pra login
  if (!user && !isAuthRoute && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Logado e tentando acessar login → manda pro kanban
  if (user && isAuthRoute) {
    return NextResponse.redirect(new URL('/inicio', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)'],
}
