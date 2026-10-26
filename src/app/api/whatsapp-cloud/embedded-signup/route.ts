import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'

const APP_ID = process.env.META_APP_ID || '2451104688636688'
// CoEx usa campos (is_on_biz_app, platform_type, smb_app_data) que exigem versão
// recente do Graph. Centralizado em env para bump fácil (a doc da Meta usa v26.0).
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0'
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

// Em Coexistência, a conta entra ATIVA por padrão — é o que o atendimento espera,
// e re-onboardar não pode mais desativar o canal sem querer (foi o que derrubou o
// atendimento repetidas vezes). Fora da janela de 24h, disparos livres viram
// ALERTA de envio manual (não template), então ativar é seguro. Para NÃO ativar
// automaticamente (ex.: número de teste), defina WHATSAPP_COEX_AUTOATIVAR=false.
const COEX_AUTOATIVAR = process.env.WHATSAPP_COEX_AUTOATIVAR !== 'false'

export const dynamic = 'force-dynamic'

type Corpo = { code?: string; phone_number_id?: string; waba_id?: string; coex?: boolean }

// Resolve o phone_number_id a partir da WABA quando o CoEx só devolve waba_id.
async function resolverPhoneNumberId(wabaId: string, token: string): Promise<string> {
  try {
    const r = await fetch(`${GRAPH}/${wabaId}/phone_numbers?fields=id,display_phone_number`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const j = await r.json()
    return j?.data?.[0]?.id || ''
  } catch {
    return ''
  }
}

// Dispara uma sincronização SMB (contatos ou histórico). Cada sync_type só pode
// ser chamado UMA vez por número; se falhar, exige offboard + novo Embedded
// Signup. Os dados chegam depois via webhook (history / smb_app_state_sync).
async function dispararSync(phoneId: string, token: string, syncType: 'smb_app_state_sync' | 'history') {
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/smb_app_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
    })
    if (!r.ok) console.error(`[embedded-signup] sync ${syncType} falhou:`, r.status, (await r.text()).slice(0, 300))
    return r.ok
  } catch (e) {
    console.error(`[embedded-signup] sync ${syncType} erro:`, e)
    return false
  }
}

export async function POST(req: NextRequest) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) return NextResponse.json({ erro: 'META_APP_SECRET ausente' }, { status: 500 })

  let corpo: Corpo
  try {
    corpo = await req.json()
  } catch {
    return NextResponse.json({ erro: 'JSON inválido' }, { status: 400 })
  }

  try {
    const { code, phone_number_id: phoneIn, waba_id, coex } = corpo
    if (!code) return NextResponse.json({ erro: 'code é obrigatório' }, { status: 400 })
    if (!phoneIn && !waba_id) {
      return NextResponse.json({ erro: 'phone_number_id ou waba_id são obrigatórios' }, { status: 400 })
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

    // Resolve phone_number_id se o CoEx só devolveu a WABA.
    let phone_number_id = phoneIn || ''
    if (!phone_number_id && waba_id) {
      phone_number_id = await resolverPhoneNumberId(waba_id, token)
    }
    if (!phone_number_id) {
      return NextResponse.json({ erro: 'não foi possível resolver o phone_number_id' }, { status: 400 })
    }

    // 2) inscreve o app na WABA (best-effort)
    if (waba_id) {
      const sub = await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!sub.ok) console.error('[embedded-signup] subscribed_apps falhou:', await sub.text())
    }

    // 3) registro do número:
    //    - CoEx: NÃO registrar. O número já está registrado no WhatsApp Business
    //      App; chamar /register quebra a coexistência.
    //    - Cloud puro: registra (best-effort; pode exigir PIN/2FA).
    if (!coex) {
      try {
        await fetch(`${GRAPH}/${phone_number_id}/register`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', pin: '000000' }),
        })
      } catch (e) {
        console.error('[embedded-signup] register falhou (ok ignorar):', e)
      }
    }

    // 4) dados de exibição + confirma o estado CoEx (is_on_biz_app / platform_type)
    let numeroExibicao = ''
    let nomeVerificado = ''
    let onBizApp: boolean | null = null
    let platformType = ''
    try {
      const info = await fetch(
        `${GRAPH}/${phone_number_id}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const infoJson = await info.json()
      numeroExibicao = infoJson?.display_phone_number || ''
      nomeVerificado = infoJson?.verified_name || ''
      onBizApp = typeof infoJson?.is_on_biz_app === 'boolean' ? infoJson.is_on_biz_app : null
      platformType = infoJson?.platform_type || ''
    } catch { /* ignore */ }

    // 5) CoEx: dispara sync de contatos e histórico DENTRO da janela de 24h.
    let syncContatos: boolean | null = null
    let syncHistorico: boolean | null = null
    if (coex) {
      syncContatos = await dispararSync(phone_number_id, token, 'smb_app_state_sync')
      syncHistorico = await dispararSync(phone_number_id, token, 'history')
    }

    // 6) salva a conta. CoEx: ativo=false por padrão (go-live gated em templates);
    //    Cloud puro mantém o comportamento anterior (ativo=true).
    const ativo = coex ? COEX_AUTOATIVAR : true
    const supabase = createServerAdminClient()
    const { error } = await supabase.from('whatsapp_contas').upsert(
      {
        waba_id: waba_id || null,
        phone_number_id,
        numero_exibicao: numeroExibicao,
        nome_verificado: nomeVerificado,
        token,
        verificado: true,
        ativo,
      },
      { onConflict: 'phone_number_id' }
    )
    if (error) {
      console.error('[embedded-signup] salvar conta falhou:', error.message)
      return NextResponse.json({ erro: 'falha ao salvar', detalhe: error.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      coex: !!coex,
      phone_number_id,
      numero: numeroExibicao,
      ativo,
      on_biz_app: onBizApp,
      platform_type: platformType,
      sync: coex ? { contatos: syncContatos, historico: syncHistorico } : undefined,
    })
  } catch (e) {
    console.error('[embedded-signup] erro:', e)
    return NextResponse.json({ erro: 'falha' }, { status: 500 })
  }
}
