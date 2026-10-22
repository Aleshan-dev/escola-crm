import { NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { validarNota } from '@/lib/memoria/regras'
import { arquivarNota, lerConfigMemoria, salvarNota } from '@/lib/memoria/servico'

// Correção (PATCH) e arquivamento (DELETE) de uma nota da memória pela equipe.
// Arquivar não apaga: a nota sai do prompt e fica no histórico.
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string; notaId: string }> }

const MOTIVOS: Record<string, string> = {
  orcamento: 'A memória deste lead está cheia. Encurte o texto ou arquive outra nota.',
  nao_encontrada: 'Nota não encontrada (já arquivada?).',
  titulo_vazio: 'Título obrigatório.',
}

export async function PATCH(req: Request, { params }: Params) {
  const { id, notaId } = await params
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const nota = validarNota(await req.json().catch(() => null))
  if (!nota) return NextResponse.json({ error: 'Nota inválida (título vazio ou dado sensível como CPF/cartão/PIX).' }, { status: 400 })

  const db = createServerAdminClient()
  const cfg = await lerConfigMemoria(db)
  const r = await salvarNota(db, { leadId: id, ...nota, origem: 'equipe', autorId: user.id, orcamento: cfg.orcamento, notaId })
  if (!r.ok) return NextResponse.json({ error: MOTIVOS[r.motivo] ?? r.motivo }, { status: 409 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id, notaId } = await params
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const ok = await arquivarNota(createServerAdminClient(), id, notaId)
  if (!ok) return NextResponse.json({ error: MOTIVOS.nao_encontrada }, { status: 404 })
  return NextResponse.json({ ok: true })
}
