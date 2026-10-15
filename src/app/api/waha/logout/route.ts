import { NextResponse } from 'next/server'
import { getWahaConfig } from '@/lib/waha'

// Logout da sessão WAHA — desconecta o número para permitir novo pareamento.
// Espelha o /api/evolution/logout. Config vem do banco ou do env.

export const dynamic = 'force-dynamic'

export async function GET() {
  const { url, key, session } = await getWahaConfig()
  if (!url || !key) {
    return NextResponse.json({ erro: 'nao configurado' }, { status: 400 })
  }
  try {
    const r = await fetch(`${url}/api/sessions/${encodeURIComponent(session)}/logout`, {
      method: 'POST',
      headers: { 'X-Api-Key': key },
    })
    if (!r.ok) return NextResponse.json({ erro: `logout HTTP ${r.status}` }, { status: 502 })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ erro: 'falha' }, { status: 500 })
  }
}
