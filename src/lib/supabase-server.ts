import { createServerClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { createClient as createServiceClient } from '@supabase/supabase-js'

type ClienteCrm = Awaited<ReturnType<typeof clienteCookie>>

export async function createClient(): Promise<ClienteCrm> {
  // Telas do ARCA (outro domínio, mesmo projeto Supabase) chamam a API do CRM com
  // `Authorization: Bearer <access_token>` em vez do cookie. O middleware já
  // validou o token e o papel da equipe; aqui o cliente passa a agir como esse
  // usuário (RLS crm.pode_operar) e `auth.getUser()` sem argumento usa o token.
  const bearer = (await headers()).get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) {
    const c = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      db: { schema: 'crm' },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const original = c.auth.getUser.bind(c.auth)
    c.auth.getUser = ((jwt?: string) => original(jwt ?? bearer)) as typeof c.auth.getUser
    return c as unknown as ClienteCrm
  }
  return clienteCookie()
}

async function clienteCookie() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      db: { schema: 'crm' },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component context — pode ignorar
          }
        },
      },
    }
  )
}

// Cliente com chave secreta — bypassa RLS (use só em webhooks confiáveis)
export function createServerAdminClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { db: { schema: 'crm' }, auth: { autoRefreshToken: false, persistSession: false } }
  )
}
