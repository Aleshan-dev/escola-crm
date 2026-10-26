import { NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { validarNota } from '@/lib/memoria/regras'
import { lerConfigMemoria, salvarNota } from '@/lib/memoria/servico'

// Memória durável do lead (src/lib/memoria): a equipe lê, cria, corrige e arquiva.
// A tabela não tem policy para o navegador; tudo passa por aqui com o admin client.
export const dynamic = 'force-dynamic'

const MOTIVOS: Record<string, string> = {
  orcamento: 'A memória deste lead está cheia. Arquive ou junte notas antes de adicionar.',
  titulo_vazio: 'Título obrigatório.',
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const db = createServerAdminClient()
  const [{ data: notas, error }, cfg] = await Promise.all([
    db.from('memoria_lead')
      .select('id, titulo, corpo, origem, autor_id, arquivada_em, substituida_por, criado_em, atualizado_em')
      .eq('lead_id', id)
      .order('criado_em'),
    lerConfigMemoria(db),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ notas: notas ?? [], ativa: cfg.ativa, orcamento: cfg.orcamento })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const nota = validarNota(await req.json().catch(() => null))
  if (!nota) return NextResponse.json({ error: 'Nota inválida (título vazio ou dado sensível como CPF/cartão/PIX).' }, { status: 400 })

  const db = createServerAdminClient()
  const cfg = await lerConfigMemoria(db)
  const r = await salvarNota(db, { leadId: id, ...nota, origem: 'equipe', autorId: user.id, orcamento: cfg.orcamento })
  if (!r.ok) return NextResponse.json({ error: MOTIVOS[r.motivo] ?? r.motivo }, { status: 409 })
  return NextResponse.json({ ok: true, id: r.id })
}
