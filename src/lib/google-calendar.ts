import { createServerAdminClient } from '@/lib/supabase-server'
import { registrarAlerta } from '@/lib/alertas'

// ADR-006: sincronização com o Google Calendar por push (webhook) em vez de polling.
// Sistema -> Google: push imediato via trigger no Postgres (tarefas insert) -> /api/google/push-tarefa.
// Google -> Sistema: watch channel + syncToken incremental, renovado 1x/dia.

const CLIENT_ID = '399470356836-r0kgrpnv5vutp8fsq263sa4kcafv9b4m.apps.googleusercontent.com'
const TZ = 'America/Rio_Branco'
const BASE_URL = 'https://escola-crm.vercel.app'
const WEBHOOK_URL = `${BASE_URL}/api/google/webhook`
const CHANNEL_TTL_MS = 30 * 24 * 60 * 60 * 1000 // Google não permite canal de eventos com vida > ~30 dias
const RENOVAR_SE_FALTAR_MS = 24 * 60 * 60 * 1000 // renova se faltar menos de 1 dia pro canal expirar

type Supabase = ReturnType<typeof createServerAdminClient>

type Integ = {
  access_token: string | null
  refresh_token: string | null
  expiry: string | null
  calendar_id: string | null
  sync_token: string | null
  channel_id: string | null
  resource_id: string | null
  channel_token: string | null
  channel_expiration: string | null
}

async function getIntegracao(supabase: Supabase): Promise<Integ | null> {
  const { data } = await supabase
    .from('integracao_google')
    .select(
      'access_token, refresh_token, expiry, calendar_id, sync_token, channel_id, resource_id, channel_token, channel_expiration'
    )
    .eq('id', 1)
    .maybeSingle()
  return (data as Integ | null) ?? null
}

/** Retorna um access_token válido (renova via refresh_token se preciso). */
export async function getGoogleToken(
  supabase: Supabase
): Promise<{ token: string; calendarId: string } | null> {
  const integ = await getIntegracao(supabase)
  if (!integ) return null
  const calendarId = integ.calendar_id || 'primary'
  const expira = integ.expiry ? new Date(integ.expiry).getTime() : 0
  if (integ.access_token && expira > Date.now() + 60000) return { token: integ.access_token, calendarId }
  if (!integ.refresh_token) return integ.access_token ? { token: integ.access_token, calendarId } : null

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
  if (!tok.access_token) return integ.access_token ? { token: integ.access_token, calendarId } : null

  await supabase
    .from('integracao_google')
    .update({
      access_token: tok.access_token,
      expiry: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
      atualizado_em: new Date().toISOString(),
    })
    .eq('id', 1)
  return { token: tok.access_token, calendarId }
}

/** Cria o evento no Google para UMA tarefa que ainda não tem google_event_id. Chamado pelo trigger (push instantâneo) e pelo resync diário (rede de segurança). */
export async function pushTarefaParaGoogle(
  supabase: Supabase,
  token: string,
  calendarId: string,
  tarefa: { id: string; titulo: string; data_hora: string }
): Promise<boolean> {
  const inicio = new Date(tarefa.data_hora)
  const fim = new Date(inicio.getTime() + 60 * 60 * 1000)
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: tarefa.titulo,
      start: { dateTime: inicio.toISOString(), timeZone: TZ },
      end: { dateTime: fim.toISOString(), timeZone: TZ },
    }),
  })
  const ev = (await r.json()) as { id?: string; error?: unknown }
  if (!ev.id) {
    await registrarAlerta(supabase, 'google/push-tarefa', `Falha ao criar evento para tarefa ${tarefa.id}: ${JSON.stringify(ev.error)}`)
    return false
  }
  await supabase.from('tarefas').update({ google_event_id: ev.id }).eq('id', tarefa.id)
  return true
}

type GoogleEvent = {
  id: string
  status?: string
  summary?: string
  start?: { dateTime?: string }
}
type ListResp = {
  items?: GoogleEvent[]
  nextPageToken?: string
  nextSyncToken?: string
  error?: { code?: number; errors?: Array<{ reason?: string }> }
}

/** Aplica uma página de eventos do Google nas tarefas locais (upsert por google_event_id; cancelados marcam status). */
async function aplicarEventos(supabase: Supabase, items: GoogleEvent[]): Promise<{ pull: number; canceladas: number }> {
  let pull = 0
  let canceladas = 0
  for (const ev of items) {
    if (ev.status === 'cancelled') {
      const { data } = await supabase.from('tarefas').update({ status: 'cancelada' }).eq('google_event_id', ev.id).select('id')
      if (data && data.length > 0) canceladas++
      continue
    }
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
  return { pull, canceladas }
}

/**
 * Puxa mudanças do Google Calendar. Usa syncToken (incremental) quando disponível;
 * cai para sync completo (-30/+180 dias) se não houver token ou se o Google responder 410
 * (token expirado/inválido — obriga a refazer do zero).
 */
export async function puxarEventosDoGoogle(
  supabase: Supabase,
  token: string,
  calendarId: string
): Promise<{ pull: number; canceladas: number; modo: 'incremental' | 'completo' }> {
  const integ = await getIntegracao(supabase)
  const syncToken = integ?.sync_token || null

  let pull = 0
  let canceladas = 0
  let pageToken: string | undefined
  let nextSyncToken: string | undefined
  let modo: 'incremental' | 'completo' = syncToken ? 'incremental' : 'completo'

  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`

  for (;;) {
    const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250', showDeleted: 'true' })
    if (pageToken) params.set('pageToken', pageToken)
    if (modo === 'incremental' && syncToken) {
      params.set('syncToken', syncToken)
    } else {
      params.set('orderBy', 'startTime')
      params.set('timeMin', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      params.set('timeMax', new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString())
    }

    const r = await fetch(`${base}?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
    const data = (await r.json()) as ListResp

    if (r.status === 410) {
      // syncToken expirado/inválido: refaz do zero, sem token, na próxima iteração.
      modo = 'completo'
      pageToken = undefined
      nextSyncToken = undefined
      continue
    }

    const aplicado = await aplicarEventos(supabase, data.items || [])
    pull += aplicado.pull
    canceladas += aplicado.canceladas

    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken
    if (data.nextPageToken) {
      pageToken = data.nextPageToken
      continue
    }
    break
  }

  await supabase
    .from('integracao_google')
    .update({ ultimo_sync: new Date().toISOString(), ...(nextSyncToken ? { sync_token: nextSyncToken } : {}) })
    .eq('id', 1)

  return { pull, canceladas, modo }
}

/** Registra (ou renova, se faltar <24h pra expirar) o canal de push notifications do Google Calendar. */
export async function registrarOuRenovarWatch(
  supabase: Supabase,
  token: string,
  calendarId: string
): Promise<{ acao: 'nenhuma' | 'registrado' | 'renovado'; expiration?: string }> {
  const integ = await getIntegracao(supabase)
  const expiraEm = integ?.channel_expiration ? new Date(integ.channel_expiration).getTime() : 0
  const precisaRenovar = !integ?.channel_id || expiraEm - Date.now() < RENOVAR_SE_FALTAR_MS

  if (!precisaRenovar) return { acao: 'nenhuma', expiration: integ?.channel_expiration || undefined }

  // Encerra o canal antigo (best-effort — se já expirou ou o Google não reconhecer, ignora o erro).
  if (integ?.channel_id && integ?.resource_id) {
    try {
      await fetch('https://www.googleapis.com/calendar/v3/channels/stop', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: integ.channel_id, resourceId: integ.resource_id }),
      })
    } catch {
      // não bloqueia o registro do novo canal
    }
  }

  const novoChannelId = crypto.randomUUID()
  const novoChannelToken = crypto.randomUUID()
  const expiration = Date.now() + CHANNEL_TTL_MS

  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: novoChannelId,
        type: 'web_hook',
        address: WEBHOOK_URL,
        token: novoChannelToken,
        expiration: String(expiration),
      }),
    }
  )
  const watch = (await r.json()) as { resourceId?: string; expiration?: string; error?: unknown }
  if (!watch.resourceId) {
    await registrarAlerta(supabase, 'google/watch', `Falha ao registrar canal de watch: ${JSON.stringify(watch.error)}`)
    throw new Error('Falha ao registrar canal de watch do Google Calendar')
  }

  const expirationIso = new Date(Number(watch.expiration ?? expiration)).toISOString()
  await supabase
    .from('integracao_google')
    .update({
      channel_id: novoChannelId,
      resource_id: watch.resourceId,
      channel_token: novoChannelToken,
      channel_expiration: expirationIso,
      atualizado_em: new Date().toISOString(),
    })
    .eq('id', 1)

  return { acao: integ?.channel_id ? 'renovado' : 'registrado', expiration: expirationIso }
}

export async function getChannelToken(supabase: Supabase): Promise<string | null> {
  const integ = await getIntegracao(supabase)
  return integ?.channel_token || null
}
