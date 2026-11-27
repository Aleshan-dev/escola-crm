import type { NextRequest } from 'next/server'
import { createClient as createJsClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase-server'

// Unificação CRM → ARCA (18/11/2026): as telas de Relacionamento do ARCA usam o
// MESMO projeto Supabase (mesmo auth.users), mas outro domínio — não há cookie
// do CRM lá. Para o ARCA enviar mensagem / avisar desfecho pelo motor do CRM,
// estas rotas aceitam também `Authorization: Bearer <access_token do ARCA>`.
// A RLS (crm.pode_operar) e o middleware (papel da equipe) valem igual.

/** Origens do ARCA liberadas no CORS das rotas acima. */
export const ORIGENS_ARCA = new Set([
  // Domínio próprio no Cloudflare (27/11/2026). O vercel.app segue durante a transição.
  'https://arca.pequenosguardioes.com',
  'https://sgei-escola-guardia.vercel.app',
  'http://localhost:8080',
])

/**
 * O ARCA pode chamar com Bearer QUALQUER rota de /api, menos as máquina-a-máquina
 * (webhooks, cron, admin, Google), que têm autenticação própria.
 */
export function rotaAceitaArca(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false
  // Exceção: o botão "Auditar agora" (Auditoria da Sara) dispara o auditor sob demanda.
  if (pathname === '/api/cron/auditor') return true
  // Exceção: "Rodar agora" do follow-up (IA Avançada) — o segredo do cron fica no servidor.
  if (pathname === '/api/admin/rodar-cron') return true
  return !/^\/api\/(webhook|cron|admin|google\/push-tarefa|google\/webhook)/.test(pathname)
}

export function bearerDe(req: NextRequest): string | null {
  return req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
}

export function clienteComToken(token: string): SupabaseClient {
  return createJsClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    db: { schema: 'crm' },
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseClient
}

/** Cliente + usuário da requisição: cookie do CRM ou Bearer do ARCA. */
export async function clienteDaRequisicao(req: NextRequest): Promise<{ supabase: SupabaseClient; user: User | null }> {
  const token = bearerDe(req)
  if (token) {
    const supabase = clienteComToken(token)
    const { data } = await supabase.auth.getUser(token)
    return { supabase, user: data.user ?? null }
  }
  const supabase = (await createClient()) as unknown as SupabaseClient
  const { data } = await supabase.auth.getUser()
  return { supabase, user: data.user ?? null }
}
