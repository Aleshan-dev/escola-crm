import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { getGoogleToken, registrarOuRenovarWatch } from '@/lib/google-calendar'
import { registrarAlerta } from '@/lib/alertas'

// ADR-006: canais de watch do Google Calendar expiram (no máx. ~30 dias) — esta rota
// registra o canal na primeira vez e renova quando faltar menos de 24h. Rodar 1x/dia
// via GitHub Actions é suficiente (custo desprezível de minutos).

export async function GET(req: NextRequest) {
  const autorizado =
    req.headers.get('x-vercel-cron') === '1' ||
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (!autorizado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supabase = createServerAdminClient()
  try {
    const ctx = await getGoogleToken(supabase)
    if (!ctx) return NextResponse.json({ error: 'Google não conectado' }, { status: 400 })
    const r = await registrarOuRenovarWatch(supabase, ctx.token, ctx.calendarId)
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('google-watch-renew falhou:', msg)
    await registrarAlerta(supabase, 'cron/google-watch-renew', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
