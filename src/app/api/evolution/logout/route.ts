import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const url = process.env.EVOLUTION_API_URL
  const key = process.env.EVOLUTION_API_KEY
  const inst = process.env.EVOLUTION_INSTANCE_NAME
  if (!url || !key || !inst) return NextResponse.json({ erro: 'nao configurado' }, { status: 400 })
  try {
    const r = await fetch(`${url}/instance/logout/${inst}`, { method: 'DELETE', headers: { apikey: key } })
    const body = await r.json().catch(() => ({}))
    return NextResponse.json({ ok: r.ok, status: r.status, body })
  } catch {
    return NextResponse.json({ erro: 'falha' }, { status: 500 })
  }
}
