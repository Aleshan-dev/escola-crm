import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { registrarAlerta } from '@/lib/alertas'
import { getGoogleToken, pushTarefaParaGoogle, puxarEventosDoGoogle } from '@/lib/google-calendar'

// ADR-006: era o cron principal (polling a cada 20min). Agora é só a REDE DE SEGURANÇA
// diária — cobre o caso raro de o trigger de push falhar ou uma notificação do webhook
// se perder. A sincronização "de verdade" acontece via /api/google/push-tarefa (instantâneo,
// disparado por um trigger no Postgres) e /api/google/webhook (push notifications do Google).

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supabase = createServerAdminClient()
  try {
    const ctx = await getGoogleToken(supabase)
    if (!ctx) return NextResponse.json({ error: 'Google não conectado' }, { status: 400 })

    // Sistema -> Google: qualquer tarefa órfã (o trigger deveria ter pego, isso é só o fallback)
    let push = 0
    const { data: novas } = await supabase.from('tarefas').select('id, titulo, data_hora').is('google_event_id', null)
    for (const t of (novas as unknown as { id: string; titulo: string; data_hora: string }[]) || []) {
      const ok = await pushTarefaParaGoogle(supabase, ctx.token, ctx.calendarId, t)
      if (ok) push++
    }

    // Google -> Sistema: incremental via syncToken (ou completo, se não houver token ainda)
    const { pull, canceladas, modo } = await puxarEventosDoGoogle(supabase, ctx.token, ctx.calendarId)

    return NextResponse.json({ ok: true, push, pull, canceladas, modo })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('google-sync falhou:', msg)
    await registrarAlerta(supabase, 'cron/google-sync', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
