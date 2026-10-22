import { NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Detalhe de um Caso: o Caso, a linha do tempo, o chat interno e o resumo do lead.
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const db = createServerAdminClient()
  const { data: caso } = await db
    .from('casos')
    .select('*, familia:familias(nome_responsavel, telefone), lead:leads(ia_ativa, precisa_atendimento_humano, coluna:colunas(nome))')
    .eq('id', id)
    .maybeSingle()
  if (!caso) return NextResponse.json({ error: 'Caso não encontrado' }, { status: 404 })

  const [{ data: eventos }, { data: chat }, { data: usuarios }] = await Promise.all([
    db.from('caso_eventos').select('id, tipo, ator, detalhe, criado_em').eq('caso_id', id).order('criado_em'),
    db.from('caso_chat').select('id, papel, conteudo, criado_em').eq('caso_id', id).order('criado_em'),
    db.from('usuarios').select('id, nome'),
  ])
  const nomes = Object.fromEntries((usuarios ?? []).map((u: { id: string; nome: string }) => [u.id, u.nome]))
  return NextResponse.json({ caso, eventos: eventos ?? [], chat: chat ?? [], nomes })
}
