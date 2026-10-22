import { NextRequest, NextResponse, after } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { acaoEquipe } from '@/lib/casos/servico'
import { executarRetornoCaso } from '@/lib/casos/retorno'
import type { AcaoEquipe } from '@/lib/casos/regras'

// Decisão da equipe sobre um Caso: concluir | pedir_info | escalar. Só a partir de
// "aguardando equipe"; ação repetida ou corrida devolve 409 (nunca finge sucesso).
// Concluir/pedir info disparam o retorno da IA à família depois da resposta HTTP
// (after); se ele morrer, o heartbeat refaz (retorno_pendente_em).
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ACOES: AcaoEquipe[] = ['concluir', 'pedir_info', 'escalar']

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const b = await req.json().catch(() => null)
  const acao = b?.acao as AcaoEquipe
  if (!ACOES.includes(acao)) return NextResponse.json({ error: 'Ação inválida' }, { status: 400 })

  const db = createServerAdminClient()
  const r = await acaoEquipe(db, { casoId: id, acao, nota: b?.nota, ator: `equipe:${user.id}` })
  if (!r.ok) return NextResponse.json({ error: r.erro }, { status: r.status })

  if (r.retorno) after(() => executarRetornoCaso(id, db).then((s) => console.log(`[casos] retorno #C${r.caso.numero}: ${s}`)))
  return NextResponse.json({ ok: true, caso: r.caso })
}
