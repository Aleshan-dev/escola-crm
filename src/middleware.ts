import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { ORIGENS_ARCA, bearerDe, clienteComToken, rotaAceitaArca } from '@/lib/auth-arca'

/** Papéis do ARCA (profiles.papel) que operam o CRM. Igual a crm.pode_operar() no banco. */
const PAPEIS_EQUIPE = new Set(['direcao', 'secretaria', 'comercial'])

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

  // Rotas que o ARCA chama de outro domínio com Bearer (ver lib/auth-arca.ts).
  const rotaArca = rotaAceitaArca(request.nextUrl.pathname)
  const origem = request.headers.get('origin') ?? ''
  const cors: Record<string, string> =
    rotaArca && ORIGENS_ARCA.has(origem)
      ? {
          'Access-Control-Allow-Origin': origem,
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : {}
  if (rotaArca && request.method === 'OPTIONS') {
    return new NextResponse(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors })
  }
  // Só JWT do Supabase conta como login do ARCA (Bearer CRON_SECRET etc. segue o caminho antigo).
  const bruto = rotaArca ? bearerDe(request) : null
  const token = bruto && /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(bruto) ? bruto : null
  const clienteToken = token ? clienteComToken(token) : null

  const user = clienteToken
    ? (await clienteToken.auth.getUser(token!)).data.user
    : (await supabase.auth.getUser()).data.user

  const url = request.nextUrl
  const isAuthRoute = url.pathname.startsWith('/login')
  // Callback do OAuth (Google): precisa passar sem exigir sessão, pois ela
  // ainda vai ser criada dentro da rota /auth/callback.
  const isAuthCallback = url.pathname.startsWith('/auth')
  // Rotas de API que fazem a própria autenticação (webhooks, cron e admin protegido por CRON_SECRET/sessão).
  // IMPORTANTE: /api/google/push-tarefa (trigger do Postgres, Bearer GOOGLE_PUSH_SECRET) e
  // /api/google/webhook (push notifications do Google, token do canal) são chamadas máquina-a-máquina
  // SEM sessão — se caírem no redirect de /login o POST vira 405 e o push instantâneo morre (era o
  // caso: visitas da Sara só sincronizavam no cron diário). Elas autenticam sozinhas, então passam direto.
  const isApiWebhook =
    url.pathname.startsWith('/api/webhook') ||
    url.pathname.startsWith('/api/cron') ||
    url.pathname.startsWith('/api/admin') ||
    url.pathname.startsWith('/api/google/push-tarefa') ||
    url.pathname.startsWith('/api/google/webhook')
  const isPublic = url.pathname.startsWith('/privacy') || url.pathname.startsWith('/termos')

  // Webhooks do WhatsApp não precisam de auth
  // Com Bearer do ARCA (só /api/cron/auditor chega aqui assim) segue para a checagem de papel.
  if (isApiWebhook && !clienteToken) return supabaseResponse

  // Deixa o callback do OAuth (Google) completar a troca do code pela sessão
  if (isAuthCallback) return supabaseResponse

  // Chamada do ARCA sem token válido: 401 com CORS (não redireciona para /login).
  if (rotaArca && !user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: cors })
  }

  // Não logado → manda pra login
  if (!user && !isAuthRoute && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // EQUIPE SÓ (18/11/2026). O CRM divide o `auth.users` com o ARCA, que agora
  // tem contas de família (app dos pais) e de professoras. Logado não basta: só
  // direção, secretaria e comercial (profiles.papel) entram. O banco já barra
  // pela RLS (crm.pode_operar()); isto evita a tela quebrada e vazia.
  const isSemAcesso = url.pathname.startsWith('/sem-acesso')
  if (user && !isPublic && !isSemAcesso) {
    const { data: perfil } = await (clienteToken ?? supabase).schema('public').from('profiles').select('papel').eq('id', user.id).maybeSingle()
    const papel = (perfil as { papel?: string } | null)?.papel ?? 'sem_acesso'
    if (!PAPEIS_EQUIPE.has(papel)) {
      if (url.pathname.startsWith('/api')) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: cors })
      }
      return NextResponse.redirect(new URL('/sem-acesso', request.url))
    }
  }

  for (const [k, v] of Object.entries(cors)) supabaseResponse.headers.set(k, v)

  // Logado e tentando acessar login → manda pro kanban
  if (user && isAuthRoute) {
    return NextResponse.redirect(new URL('/inicio', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)'],
}
