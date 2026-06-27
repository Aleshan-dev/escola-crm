import { NextResponse } from 'next/server'

export async function GET() {
  const url = process.env.EVOLUTION_API_URL
  const key = process.env.EVOLUTION_API_KEY
  const inst = process.env.EVOLUTION_INSTANCE_NAME
  if (!url || !key || !inst) return NextResponse.json({ state: 'unconfigured' })
  try {
    const r = await fetch(`${url}/instance/connectionState/${inst}`, { headers: { apikey: key } })
    const j = await r.json()
    const state = j?.instance?.state || j?.state || 'unknown'
    return NextResponse.json({ state })
  } catch {
    return NextResponse.json({ state: 'erro' })
  }
}
