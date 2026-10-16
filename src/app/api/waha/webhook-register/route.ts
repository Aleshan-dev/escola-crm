import { NextResponse } from 'next/server'
import { getWahaConfig } from '@/lib/waha'

// Registra (ou confere) o webhook de ENTRADA na sessão do WAHA, para que as
// mensagens recebidas cheguem em /api/webhook/waha. Protegida pela sessão (middleware).
//
// Eventos:
// - 'message.any'    — cobre recebidas E enviadas (fromMe) num único evento; assinar
//                      'message' junto entregaria as recebidas em dobro.
// - 'message.ack'    — recibos de entrega das mensagens que ENVIAMOS (entregue ✓✓ /
//                      lido ✓✓ azul), tratados em /api/webhook/waha e gravados em mensagens.status.
// - 'session.status' — mudanças de estado da sessão (conectou/caiu); mantido para o
//                      status/guardião do canal. O webhook ignora eventos que não trata.
//
// ⚠️ Ao MUDAR esta lista, é preciso RE-REGISTRAR o webhook (POST aqui, ou o botão
//    na tela Configurações → WhatsApp Disparos) para o WAHA passar a enviar o novo evento.

export const dynamic = 'force-dynamic'

const EVENTOS = ['message.any', 'message.ack', 'session.status']

function alvoWebhook(): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://escola-crm.vercel.app').replace(/\/+$/, '')
  const secret = process.env.WAHA_WEBHOOK_SECRET
  return `${base}/api/webhook/waha${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`
}

// Considera registrado se algum webhook aponta para o nosso path (ignora o secret).
function jaRegistrado(webhooks: unknown, base: string): boolean {
  if (!Array.isArray(webhooks)) return false
  return webhooks.some((w) => typeof w?.url === 'string' && w.url.startsWith(base))
}

export async function GET() {
  const { url, key, session } = await getWahaConfig()
  const alvo = alvoWebhook()
  const basePath = alvo.split('?')[0]
  if (!url || !key) {
    return NextResponse.json({ alvo, registrado: false, erro: 'nao configurado' }, { status: 400 })
  }
  try {
    const r = await fetch(`${url}/api/sessions/${encodeURIComponent(session)}`, {
      headers: { 'X-Api-Key': key },
      cache: 'no-store',
    })
    if (!r.ok) return NextResponse.json({ alvo, registrado: false, erro: `session HTTP ${r.status}` })
    const j = await r.json()
    const webhooks = j?.config?.webhooks
    return NextResponse.json({ alvo, registrado: jaRegistrado(webhooks, basePath), webhooks: webhooks ?? [] })
  } catch (e) {
    return NextResponse.json({ alvo, registrado: false, erro: e instanceof Error ? e.message : 'falha' })
  }
}

export async function POST() {
  const { url, key, session } = await getWahaConfig()
  const alvo = alvoWebhook()
  if (!url || !key) {
    return NextResponse.json({ erro: 'nao configurado' }, { status: 400 })
  }
  try {
    const r = await fetch(`${url}/api/sessions/${encodeURIComponent(session)}`, {
      method: 'PUT',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { webhooks: [{ url: alvo, events: EVENTOS }] } }),
    })
    if (!r.ok) {
      const t = await r.text()
      return NextResponse.json({ erro: `PUT session HTTP ${r.status}: ${t.slice(0, 200)}` }, { status: 502 })
    }
    return NextResponse.json({ ok: true, alvo })
  } catch (e) {
    return NextResponse.json({ erro: e instanceof Error ? e.message : 'falha' }, { status: 500 })
  }
}
