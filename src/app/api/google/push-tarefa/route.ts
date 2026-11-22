import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { atualizarTarefaNoGoogle, excluirEventoNoGoogle, getGoogleToken, pushTarefaParaGoogle } from '@/lib/google-calendar'

// ADR-006: chamado pelos triggers do Postgres em crm.tarefas — cria/atualiza/apaga o
// evento no Google na hora, em vez de esperar o cron varrer a tabela. Autenticado com
// um segredo próprio (GOOGLE_PUSH_SECRET), separado do CRON_SECRET.
//   acao 'criar' (padrão)  → trg_push_google_tarefa (insert sem google_event_id)
//   acao 'atualizar'       → trg_google_tarefa_alterada (data_hora/título/status mudou)
//   acao 'excluir'         → trg_google_tarefa_excluida (linha apagada; manda o google_event_id)

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const supabase = createServerAdminClient()
  // Fonte única do segredo = Vault do banco (22/11/2026): a variável da Vercel tinha ficado
  // com um valor antigo e TODO aviso do banco voltava 401. A env segue aceita por compat.
  const okEnv = !!process.env.GOOGLE_PUSH_SECRET && token === process.env.GOOGLE_PUSH_SECRET
  let autorizado = okEnv
  if (!autorizado && token) {
    const { data } = await supabase.rpc('google_push_confere', { p_token: token })
    autorizado = data === true
  }
  if (!autorizado) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | { tarefa_id?: string; acao?: string; google_event_id?: string }
    | null
  const acao = body?.acao ?? 'criar'

  if (acao === 'excluir') {
    if (!body?.google_event_id) return NextResponse.json({ error: 'google_event_id ausente' }, { status: 400 })
    const ctx = await getGoogleToken(supabase)
    if (!ctx) return NextResponse.json({ error: 'Google não conectado' }, { status: 400 })
    const ok = await excluirEventoNoGoogle(supabase, ctx.token, ctx.calendarId, body.google_event_id)
    return NextResponse.json({ ok })
  }

  const tarefaId = body?.tarefa_id
  if (!tarefaId) return NextResponse.json({ error: 'tarefa_id ausente' }, { status: 400 })

  const { data: tarefa } = await supabase
    .from('tarefas')
    .select('id, titulo, data_hora, status, google_event_id')
    .eq('id', tarefaId)
    .maybeSingle()

  if (!tarefa) return NextResponse.json({ error: 'tarefa não encontrada' }, { status: 404 })
  if (acao === 'criar' && tarefa.google_event_id) return NextResponse.json({ ok: true, skip: 'já sincronizada' })

  const ctx = await getGoogleToken(supabase)
  if (!ctx) return NextResponse.json({ error: 'Google não conectado' }, { status: 400 })

  const ok =
    acao === 'atualizar'
      ? await atualizarTarefaNoGoogle(supabase, ctx.token, ctx.calendarId, tarefa)
      : await pushTarefaParaGoogle(supabase, ctx.token, ctx.calendarId, tarefa)
  return NextResponse.json({ ok })
}
