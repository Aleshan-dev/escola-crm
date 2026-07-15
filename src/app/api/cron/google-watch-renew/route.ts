import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { getGoogleToken, registrarOuRenovarWatch, pushTarefaParaGoogle, puxarEventosDoGoogle } from '@/lib/google-calendar'
import { registrarAlerta } from '@/lib/alertas'

// ADR-006: canais de watch do Google Calendar expiram (no máx. ~30 dias) — esta rota
// registra o canal na primeira vez e renova quando faltar menos de 24h.
// No plano Hobby o cron é diário e limitado a 2 jobs, então esta rota também faz a
// REDE DE SEGURANÇA de sync (antes num cron separado): empurra tarefas órfãs e puxa
// eventos do Google, cobrindo notificações de push eventualmente perdidas.

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

    // 1) Renova o canal de watch (push notifications).
    const watch = await registrarOuRenovarWatch(supabase, ctx.token, ctx.calendarId)

    // 2) Rede de segurança: resync (tarefas órfãs -> Google, e Google -> sistema).
    let push = 0
    const { data: novas } = await supabase.from('tarefas').select('id, titulo, data_hora').is('google_event_id', null)
    for (const t of (novas as unknown as { id: string; titulo: string; data_hora: string }[]) || []) {
      const ok = await pushTarefaParaGoogle(supabase, ctx.token, ctx.calendarId, t)
      if (ok) push++
    }
    const sync = await puxarEventosDoGoogle(supabase, ctx.token, ctx.calendarId)

    return NextResponse.json({ ok: true, watch, push, ...sync })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('google-watch-renew falhou:', msg)
    await registrarAlerta(supabase, 'cron/google-watch-renew', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
