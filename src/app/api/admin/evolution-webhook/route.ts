import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// Lê e ajusta a configuração do webhook do Evolution (usa as credenciais do servidor).
// Protegido pelo CRON_SECRET (Bearer/?secret=) ou sessão do CRM.
// ?action=find  -> mostra a config atual
// ?action=set   -> aplica a config recomendada (evento MESSAGES_UPSERT + URL do webhook)

async function autorizado(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  const q = req.nextUrl.searchParams.get('secret')
  if (secret && (auth === `Bearer ${secret}` || q === secret)) return true
  try {
    const sb = await createClient()
    const { data } = await sb.auth.getUser()
    return !!data.user
  } catch {
    return false
  }
}

// MESSAGES_UPSERT cobre mensagens recebidas E enviadas (inclui as fromMe manuais do celular).
const EVENTOS_RECOMENDADOS = ['MESSAGES_UPSERT']

export async function GET(req: NextRequest) {
  if (!(await autorizado(req))) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const url = process.env.EVOLUTION_API_URL
  const key = process.env.EVOLUTION_API_KEY
  const inst = process.env.EVOLUTION_INSTANCE_NAME
  if (!url || !key || !inst) {
    return NextResponse.json({ error: 'Evolution não configurado' }, { status: 400 })
  }

  const action = req.nextUrl.searchParams.get('action') || 'find'

  try {
    if (action === 'find') {
      const r = await fetch(`${url}/webhook/find/${inst}`, { headers: { apikey: key } })
      const config = await r.json().catch(() => null)
      return NextResponse.json({ http: r.status, config })
    }

    if (action === 'set') {
      const webhookUrl =
        req.nextUrl.searchParams.get('url') ||
        'https://escola-crm.vercel.app/api/webhook/whatsapp'
      const payload = {
        webhook: {
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          webhookBase64: false,
          events: EVENTOS_RECOMENDADOS,
        },
      }
      const r = await fetch(`${url}/webhook/set/${inst}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key },
        body: JSON.stringify(payload),
      })
      const resposta = await r.json().catch(() => null)
      return NextResponse.json({ http: r.status, enviado: payload, resposta })
    }

    return NextResponse.json({ error: 'action inválido — use find ou set' }, { status: 400 })
  } catch (e) {
    return NextResponse.json(
      { error: 'Falha ao falar com o Evolution', detalhe: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    )
  }
}
