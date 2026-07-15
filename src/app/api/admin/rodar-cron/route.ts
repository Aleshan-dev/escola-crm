import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// Dispara manualmente, sob autenticação de sessão, os mesmos jobs do cron:
// - follow-up / lembretes / auto-perdido
// - renovação do canal do Google + resync (rede de segurança)
// O segredo do cron fica no servidor; o usuário logado só aciona.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const origin = req.nextUrl.origin
  const secret = process.env.CRON_SECRET || ''
  const headers = { Authorization: `Bearer ${secret}` }

  const [followup, google] = await Promise.allSettled([
    fetch(`${origin}/api/cron/followup`, { headers, cache: 'no-store' }).then((r) => r.json()),
    fetch(`${origin}/api/cron/google-watch-renew`, { headers, cache: 'no-store' }).then((r) => r.json()),
  ])

  return NextResponse.json({
    ok: true,
    followup: followup.status === 'fulfilled' ? followup.value : { erro: String(followup.reason) },
    google: google.status === 'fulfilled' ? google.value : { erro: String(google.reason) },
  })
}
