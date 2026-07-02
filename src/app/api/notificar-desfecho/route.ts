import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { notificarGestor } from '@/lib/notificacoes'

// Notifica o gestor quando um lead é movido (manualmente) para um desfecho
// do funil (Matriculados ou Perdidos). Chamado pelo front após a mudança de etapa.
export async function POST(req: NextRequest) {
  const sb = await createClient()
  const { data: userData } = await sb.auth.getUser()
  if (!userData.user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id, coluna } = await req.json().catch(() => ({}))
  if (!lead_id || !coluna) {
    return NextResponse.json({ error: 'lead_id e coluna obrigatórios' }, { status: 400 })
  }
  if (!/matric|perdid/i.test(coluna)) return NextResponse.json({ ignored: 'nao_terminal' })

  const admin = createServerAdminClient()
  const { data: lead } = await admin
    .from('leads')
    .select('familia:familias(nome_responsavel, telefone)')
    .eq('id', lead_id)
    .maybeSingle()

  const fam = (lead as { familia?: { nome_responsavel?: string; telefone?: string } } | null)?.familia
  const nome = fam?.nome_responsavel || 'Família'
  const tel = fam?.telefone || ''
  const emoji = /matric/i.test(coluna) ? '🎉' : '🚫'
  const msg = `${emoji} *Atendimento encerrado — ${coluna}*\nFamília: ${nome}${tel ? `\nTelefone: ${tel}` : ''}`

  await notificarGestor(admin, 'encerramento', msg)
  return NextResponse.json({ ok: true })
}
