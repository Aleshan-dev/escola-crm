import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { rodarAuditoria } from '@/lib/auditoria'

// Dispara a auditoria da Sara sob demanda (session-authed), sem esperar o cron.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  try {
    const admin = createServerAdminClient()
    const { id } = await rodarAuditoria(admin)
    return NextResponse.json({ ok: true, id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'erro' }, { status: 500 })
  }
}
