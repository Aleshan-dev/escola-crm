import { NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { getGoogleToken } from '@/lib/google-calendar'

// "Conectado" só pode ser verdade se der pra obter um access_token VÁLIDO agora.
// Antes isto só checava a existência da linha id=1 — que persiste desde o primeiro
// connect — então o badge ficava verde mesmo com o refresh_token morto, mascarando
// a desconexão por semanas. getGoogleToken renova se preciso e devolve null se falhar.
export async function GET() {
  const supabase = createServerAdminClient()
  const { data } = await supabase.from('integracao_google').select('id').eq('id', 1).maybeSingle()
  if (!data) return NextResponse.json({ conectado: false, motivo: 'nunca_conectado' })

  const ctx = await getGoogleToken(supabase)
  return NextResponse.json({
    conectado: !!ctx,
    ...(ctx ? {} : { motivo: 'token_invalido' }),
  })
}
