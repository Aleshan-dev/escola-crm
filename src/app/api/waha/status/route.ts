import { NextResponse } from 'next/server'
import { wahaConnectionState, wahaConfigurado, getWahaConfig } from '@/lib/waha'

// Status da sessão WAHA para a tela de conexão (configuracoes/waha).
// Também informa se a flag WHATSAPP_PROVIDER já está em 'waha', para a UI avisar
// quando a sessão está de pé mas o CRM ainda dispara pelo Evolution.

export const dynamic = 'force-dynamic'

export async function GET() {
  const provider = (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase()
  const { session } = await getWahaConfig()

  if (!(await wahaConfigurado())) {
    return NextResponse.json({ state: 'unconfigured', provider, session, configurado: false })
  }

  const r = await wahaConnectionState()
  if (!r.ok) {
    return NextResponse.json({ state: 'erro', erro: r.erro, provider, session, configurado: true })
  }
  const p = r.payload as { state?: string; wahaStatus?: string }
  return NextResponse.json({
    state: p?.state || 'desconhecido',
    wahaStatus: p?.wahaStatus,
    provider,
    session,
    configurado: true,
  })
}
