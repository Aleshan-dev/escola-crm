import { NextResponse } from 'next/server'

export async function GET() {
  const url = process.env.EVOLUTION_API_URL
  const key = process.env.EVOLUTION_API_KEY
  const inst = process.env.EVOLUTION_INSTANCE_NAME
  if (!url || !key || !inst) return NextResponse.json({ erro: 'nao configurado' }, { status: 400 })
  try {
    const r = await fetch(`${url}/instance/connect/${inst}`, { headers: { apikey: key } })
    const j = await r.json()
    const base64 = j?.base64 || j?.qrcode?.base64 || null
    const pairingCode = j?.pairingCode || j?.code || null
    return NextResponse.json({ base64, pairingCode })
  } catch {
    return NextResponse.json({ erro: 'falha' }, { status: 500 })
  }
}
