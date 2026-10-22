import { NextResponse } from 'next/server'
import { getWahaConfig } from '@/lib/waha'

// Conexão da sessão WAHA: garante a sessão de pé, espera chegar em SCAN_QR_CODE
// e devolve o QR em base64 (data URL). Se já estiver WORKING, avisa que está
// conectada. Espelha o /api/evolution/connect, mas na API de sessões do WAHA.
// Config (url/key/session) vem do banco (crm.integracao_waha) ou do env.

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Webhook de entrada a registrar já na criação da sessão (as recebidas caem em
// /api/webhook/waha). Sessões já existentes: usar /api/waha/webhook-register.
function alvoWebhook(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://escola-crm.vercel.app').replace(/\/+$/, '')
  const secret = process.env.WAHA_WEBHOOK_SECRET
  return `${base}/api/webhook/waha${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`
}

export async function GET() {
  const { url, key, session } = await getWahaConfig()
  if (!url || !key) {
    return NextResponse.json({ erro: 'nao configurado' }, { status: 400 })
  }

  const headers = { 'X-Api-Key': key }
  const headersJson = { 'X-Api-Key': key, 'Content-Type': 'application/json' }

  const statusAtual = async (): Promise<string> => {
    const r = await fetch(`${url}/api/sessions/${encodeURIComponent(session)}`, { headers, cache: 'no-store' })
    if (r.status === 404) return 'STOPPED'
    if (!r.ok) return 'ERRO'
    const j = await r.json()
    return j?.status || 'UNKNOWN'
  }

  // Garante a sessão de pé, tolerante à versão do WAHA:
  //   1) start da sessão existente (API nova);
  //   2) se 404/422, CRIA a sessão já iniciando (POST /api/sessions {name,start});
  //   3) fallback do endpoint legado (POST /api/sessions/start {name}).
  const garantirSessao = async (): Promise<void> => {
    const start = await fetch(`${url}/api/sessions/${encodeURIComponent(session)}/start`, {
      method: 'POST', headers,
    }).catch(() => null)
    if (start && start.ok) return

    const criar = await fetch(`${url}/api/sessions`, {
      method: 'POST', headers: headersJson,
      body: JSON.stringify({
        name: session,
        start: true,
        config: { webhooks: [{ url: alvoWebhook(), events: ['message.any'] }] },
      }),
    }).catch(() => null)
    if (criar && (criar.ok || criar.status === 422)) {
      // 422 = já existe: tenta iniciar de novo (pode ter sido criada parada).
      if (criar.status === 422) {
        await fetch(`${url}/api/sessions/${encodeURIComponent(session)}/start`, { method: 'POST', headers }).catch(() => {})
      }
      return
    }

    // WAHA antigo, sem POST /api/sessions.
    await fetch(`${url}/api/sessions/start`, {
      method: 'POST', headers: headersJson,
      body: JSON.stringify({ name: session }),
    }).catch(() => {})
  }

  try {
    // 1. Cria/inicia a sessão.
    await garantirSessao()

    // 2. Espera sair de STARTING para SCAN_QR_CODE (pronta p/ parear) ou WORKING
    //    (já conectada). FAILED interrompe. Primeiro boot do engine pode demorar.
    let status = 'STARTING'
    for (let i = 0; i < 12; i++) {
      status = await statusAtual()
      if (status === 'SCAN_QR_CODE' || status === 'WORKING' || status === 'FAILED') break
      await new Promise((r) => setTimeout(r, 1000))
    }

    if (status === 'WORKING') return NextResponse.json({ status, base64: null, jaConectado: true })
    if (status !== 'SCAN_QR_CODE') return NextResponse.json({ status, base64: null })

    // 3. QR em base64 (Accept: application/json → { mimetype, data }).
    const qr = await fetch(`${url}/api/${encodeURIComponent(session)}/auth/qr`, {
      headers: { ...headers, Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!qr.ok) return NextResponse.json({ status, base64: null, erro: `qr HTTP ${qr.status}` })
    const j = await qr.json()
    const data: string | null = j?.data || j?.base64 || null
    const mimetype: string = j?.mimetype || 'image/png'
    const base64 = data ? `data:${mimetype};base64,${data}` : null
    return NextResponse.json({ status, base64 })
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : 'falha' }, { status: 500 })
  }
}
