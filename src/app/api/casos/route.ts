import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { ESTADOS_ABERTOS } from '@/lib/casos/regras'

// Fila de Casos (tela /casos). Abas: abertos (aguardando equipe/família) e
// concluídos (os terminais, últimos 100). Leitura pelo servidor: as tabelas de
// Caso não têm política para o browser.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const aba = req.nextUrl.searchParams.get('aba') === 'concluidos' ? 'concluidos' : 'abertos'
  const db = createServerAdminClient()

  let q = db
    .from('casos')
    .select('id, numero, lead_id, agente, titulo, tipo, origem, estado, cobrancas, criado_em, atualizado_em, fechado_em, familia:familias(nome_responsavel)')
  q = aba === 'abertos'
    ? q.in('estado', ESTADOS_ABERTOS).order('criado_em', { ascending: true })
    : q.not('estado', 'in', `(${ESTADOS_ABERTOS.join(',')})`).order('fechado_em', { ascending: false }).limit(100)

  const [{ data, error }, { count: abertos }] = await Promise.all([
    q,
    db.from('casos').select('id', { count: 'exact', head: true }).in('estado', ESTADOS_ABERTOS),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ casos: data ?? [], abertos: abertos ?? 0 })
}
