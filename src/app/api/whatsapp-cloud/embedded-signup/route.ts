import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'

const APP_ID = process.env.META_APP_ID || '2451104688636688'
const GRAPH = 'https://graph.facebook.com/v21.0'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) return NextResponse.json({ erro: 'META_APP_SECRET ausente' }, { status: 500 })
  try {
    const { code, phone_number_id, waba_id } = await req.json()
    if (!code || !phone_number_id) {
      return NextResponse.json({ erro: 'code e phone_number_id são obrigatórios' }, { status: 400 })
    }

    // 1) troca o code por um token
    const tokenRes = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${APP_ID}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`
    )
    const tokenJson = await tokenRes.json()
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error('[embedded-signup] troca de token falhou:', JSON.stringify(tokenJson))
      return NextResponse.json({ erro: 'falha ao trocar code por token', detalhe: tokenJson }, { status: 400 })
    }
    const token: string = tokenJson.access_token

    // 2) inscreve o app na WABA (best-effort)
    if (waba_id) {
      const sub = await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!sub.ok) console.error('[embedded-signup] subscribed_apps falhou:', await sub.text())
    }

    // 3) registra o número (best-effort; pode exigir PIN/2FA)
    try {
      await fetch(`${GRAPH}/${phone_number_id}/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin: '000000' }),
      })
    } catch (e) {
      console.error('[embedded-signup] register falhou (ok ignorar):', e)
    }

    // 4) busca dados de exibição do número
    let numeroExibicao = ''
    let nomeVerificado = ''
    try {
      const info = await fetch(`${GRAPH}/${phone_number_id}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const infoJson = await info.json()
      numeroExibicao = infoJson?.display_phone_number || ''
      nomeVerificado = infoJson?.verified_name || ''
    } catch { /* ignore */ }

    // 5) salva a conta
    const supabase = createServerAdminClient()
    const { error } = await supabase.from('whatsapp_contas').upsert(
      {
        waba_id: waba_id || null,
        phone_number_id,
        numero_exibicao: numeroExibicao,
        nome_verificado: nomeVerificado,
        token,
        verificado: true,
        ativo: true,
      },
      { onConflict: 'phone_number_id' }
    )
    if (error) {
      console.error('[embedded-signup] salvar conta falhou:', error.message)
      return NextResponse.json({ erro: 'falha ao salvar', detalhe: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, phone_number_id, numero: numeroExibicao })
  } catch (e) {
    console.error('[embedded-signup] erro:', e)
    return NextResponse.json({ erro: 'falha' }, { status: 500 })
  }
}
