import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { getGoogleToken, getChannelToken, puxarEventosDoGoogle } from '@/lib/google-calendar'
import { registrarAlerta } from '@/lib/alertas'

// ADR-006: recebe as notificações push do Google Calendar (registradas em
// registrarOuRenovarWatch). O Google não manda o que mudou, só avisa "algo mudou" —
// a gente então puxa o delta via syncToken. Responde 200 rápido (o Google reenvia com
// backoff se não receber 2xx), a sincronização roda antes de responder porque o delta
// costuma ser pequeno o suficiente para caber dentro do timeout da function.

export const maxDuration = 30

export async function POST(req: NextRequest) {
  const channelId = req.headers.get('x-goog-channel-id')
  const resourceState = req.headers.get('x-goog-resource-state')
  const channelToken = req.headers.get('x-goog-channel-token')

  const supabase = createServerAdminClient()

  const tokenEsperado = await getChannelToken(supabase)
  if (!channelId || !tokenEsperado || channelToken !== tokenEsperado) {
    // Não é o Google (ou é um canal antigo/já trocado) — responde 200 pra não gerar retry,
    // mas não faz nada.
    return NextResponse.json({ ok: true, ignorado: 'canal/token não confere' })
  }

  // "sync" é o ping de handshake que o Google manda ao registrar o canal — não há mudança real ainda.
  if (resourceState === 'sync') {
    return NextResponse.json({ ok: true, handshake: true })
  }

  try {
    const ctx = await getGoogleToken(supabase)
    if (!ctx) return NextResponse.json({ ok: true, skip: 'google não conectado' })
    const r = await puxarEventosDoGoogle(supabase, ctx.token, ctx.calendarId)
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('google/webhook falhou:', msg)
    await registrarAlerta(supabase, 'google/webhook', msg)
    // Responde 200 mesmo assim: o resync diário (rede de segurança) cobre o que ficar pra trás,
    // e devolver erro só faz o Google reenviar a mesma notificação repetidamente.
    return NextResponse.json({ ok: false, error: msg })
  }
}
