import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { getGoogleToken, pushTarefaParaGoogle } from '@/lib/google-calendar'

// ADR-006: chamado pelo trigger `trg_push_google_tarefa` (Postgres) toda vez que uma
// tarefa nova é inserida sem google_event_id — cria o evento no Google na hora, em vez
// de esperar o cron varrer a tabela. Autenticado com um segredo próprio (GOOGLE_PUSH_SECRET),
// separado do CRON_SECRET, pra limitar o raio de exposição caso um dos dois vaze.

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (!process.env.GOOGLE_PUSH_SECRET || auth !== `Bearer ${process.env.GOOGLE_PUSH_SECRET}`) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as { tarefa_id?: string } | null
  const tarefaId = body?.tarefa_id
  if (!tarefaId) return NextResponse.json({ error: 'tarefa_id ausente' }, { status: 400 })

  const supabase = createServerAdminClient()

  const { data: tarefa } = await supabase
    .from('tarefas')
    .select('id, titulo, data_hora, google_event_id')
    .eq('id', tarefaId)
    .maybeSingle()

  if (!tarefa) return NextResponse.json({ error: 'tarefa não encontrada' }, { status: 404 })
  if (tarefa.google_event_id) return NextResponse.json({ ok: true, skip: 'já sincronizada' })

  const ctx = await getGoogleToken(supabase)
  if (!ctx) return NextResponse.json({ error: 'Google não conectado' }, { status: 400 })

  const ok = await pushTarefaParaGoogle(supabase, ctx.token, ctx.calendarId, tarefa)
  return NextResponse.json({ ok })
}
