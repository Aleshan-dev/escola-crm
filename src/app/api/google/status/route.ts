import { NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'

export async function GET() {
  const supabase = createServerAdminClient()
  const { data } = await supabase.from('integracao_google').select('id, atualizado_em').eq('id', 1).maybeSingle()
  return NextResponse.json({ conectado: !!data })
}
