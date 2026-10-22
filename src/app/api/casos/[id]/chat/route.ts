import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { perguntarSobreCaso } from '@/lib/casos/chat-interno'

// Conversa interna da equipe com a IA sobre o Caso. Nunca vai para a família e
// não muda o Caso. CHAMA A IA (tem custo); limites em src/lib/casos/chat-interno.ts.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const b = await req.json().catch(() => null)
  const r = await perguntarSobreCaso(createServerAdminClient(), {
    casoId: id,
    pergunta: String(b?.pergunta ?? ''),
    turnId: String(b?.turn_id ?? ''),
    usuarioId: user.id,
  })
  if (!r.ok) return NextResponse.json({ error: r.erro }, { status: r.status })
  return NextResponse.json({ resposta: r.resposta })
}
