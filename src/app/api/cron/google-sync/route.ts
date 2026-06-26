import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'

const CLIENT_ID = '399470356836-r0kgrpnv5vutp8fsq263sa4kcafv9b4m.apps.googleusercontent.com'
const TZ = 'America/Rio_Branco'
const CAL = 'primary'

type Integ = { access_token: string | null; refresh_token: string | null; expiry: string | null }

async function getToken(supabase: ReturnType<typeof createServerAdminClient>): Promise<string | null> {
  const { data } = await supabase.from('integracao_google').select('access_token, refresh_token, expiry').eq('id', 1).maybeSingle()
  const integ = data as Integ | null
  if (!integ) return null
  const expira = integ.expiry ? new Date(integ.expiry).getTime() : 0
  if (integ.access_token && expira > Date.now() + 60000) return integ.access_token
  if (!integ.refresh_token) return integ.access_token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: integ.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const tok = (await resp.json()) as { access_token?: string; expires_in?: number }
  if (!tok.access_token) return integ.access_token
  await supabase.from('integracao_google').update({
    access_token: tok.access_token,
    expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(),
  }).eq('id', 1)
  return tok.access_token
}

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supabase = createServerAdminClient()
  const token = await getToken(supabase)
  if (!token) return NextResponse.json({ error: 'Google não conectado' }, { status: 400 })

  let push = 0
  let pull = 0

  // 1) Sistema -> Google: tarefas sem evento ainda
  const { data: novas } = await supabase.from('tarefas').select('id, titulo, data_hora').is('google_event_id', null)
  for (const t of (novas as unknown as { id: string; titulo: string; data_hora: string }[]) || []) {
    const inicio = new Date(t.data_hora)
    const fim = new Date(inicio.getTime() + 60 * 60 * 1000)
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${CAL}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: t.titulo,
        start: { dateTime: inicio.toISOString(), timeZone: TZ },
        end: { dateTime: fim.toISOString(), timeZone: TZ },
      }),
    })
    const ev = (await r.json()) as { id?: string }
    if (ev.id) {
      await supabase.from('tarefas').update({ google_event_id: ev.id }).eq('id', t.id)
      push++
    }
  }

  // 2) Google -> Sistema: eventos da agenda
  const timeMin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const timeMax = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
  const url = `https://www.googleapis.com/calendar/v3/calendars/${CAL}/events?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
  const lr = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const lista = (await lr.json()) as { items?: Array<{ id: string; summary?: string; start?: { dateTime?: string } }> }
  for (const ev of lista.items || []) {
    if (!ev.start?.dateTime) continue
    const quando = new Date(ev.start.dateTime).toISOString()
    const { data: existente } = await supabase.from('tarefas').select('id').eq('google_event_id', ev.id).maybeSingle()
    if (existente) {
      await supabase.from('tarefas').update({ titulo: ev.summary || 'Evento', data_hora: quando }).eq('google_event_id', ev.id)
    } else {
      await supabase.from('tarefas').insert({
        titulo: ev.summary || 'Evento do Google',
        tipo: 'geral',
        data_hora: quando,
        google_event_id: ev.id,
      })
      pull++
    }
  }

  await supabase.from('integracao_google').update({ ultimo_sync: new Date().toISOString() }).eq('id', 1)
  return NextResponse.json({ ok: true, push, pull })
}
