import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Puxa o histórico de um contato do Evolution e faz backfill na tabela `mensagens`.
// Protegido pelo CRON_SECRET (Bearer ou ?secret=). Uso admin/pontual.

type EvoMsg = {
  key?: { id?: string; remoteJid?: string; fromMe?: boolean }
  message?: {
    conversation?: string
    extendedTextMessage?: { text?: string }
    imageMessage?: { caption?: string }
  }
  messageTimestamp?: number | string
  pushName?: string
}

async function autorizado(req: NextRequest): Promise<boolean> {
  // 1) CRON_SECRET (uso admin/cron via Bearer ou ?secret=)
  const secret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  const q = req.nextUrl.searchParams.get('secret')
  if (secret && (auth === `Bearer ${secret}` || q === secret)) return true
  // 2) Usuário logado no CRM (sessão do Supabase via cookie) — usado pelo botão da UI
  try {
    const sb = await createClient()
    const { data } = await sb.auth.getUser()
    return !!data.user
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  if (!(await autorizado(req))) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const telefone = (req.nextUrl.searchParams.get('telefone') || '').replace(/\D/g, '')
  if (!telefone) {
    return NextResponse.json({ error: 'Informe ?telefone=' }, { status: 400 })
  }
  const debug = req.nextUrl.searchParams.get('debug') === '1'

  const url = process.env.EVOLUTION_API_URL
  const key = process.env.EVOLUTION_API_KEY
  const inst = process.env.EVOLUTION_INSTANCE_NAME
  if (!url || !key || !inst) {
    return NextResponse.json({ error: 'Evolution não configurado' }, { status: 400 })
  }

  const remoteJid = `${telefone}@s.whatsapp.net`

  let raw: unknown
  try {
    const r = await fetch(`${url}/chat/findMessages/${inst}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ where: { key: { remoteJid } } }),
    })
    raw = await r.json()
    if (debug) {
      return NextResponse.json({ http: r.status, amostra: raw }, { status: 200 })
    }
  } catch (e) {
    return NextResponse.json(
      { error: 'Falha ao chamar o Evolution', detalhe: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    )
  }

  // Normaliza os formatos possíveis de resposta do Evolution
  const r2 = raw as {
    messages?: { records?: EvoMsg[] } | EvoMsg[]
    records?: EvoMsg[]
  }
  const records: EvoMsg[] = Array.isArray(raw)
    ? (raw as EvoMsg[])
    : Array.isArray(r2?.messages)
      ? (r2.messages as EvoMsg[])
      : Array.isArray(r2?.messages?.records)
        ? ((r2.messages as { records?: EvoMsg[] }).records as EvoMsg[])
        : Array.isArray(r2?.records)
          ? (r2.records as EvoMsg[])
          : []

  const supabase = createServerAdminClient()

  const { data: familia } = await supabase
    .from('familias')
    .select('id')
    .eq('telefone', telefone)
    .maybeSingle()
  if (!familia) {
    return NextResponse.json({ error: 'Família não encontrada para esse telefone' }, { status: 404 })
  }
  const { data: lead } = await supabase
    .from('leads')
    .select('id')
    .eq('familia_id', familia.id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!lead) {
    return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })
  }

  let inseridas = 0
  let ignoradasSemTexto = 0
  let jaExistiam = 0

  for (const m of records) {
    const wid = m.key?.id
    const texto =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption
    if (!wid || !texto) {
      ignoradasSemTexto++
      continue
    }

    const { data: existe } = await supabase
      .from('mensagens')
      .select('id')
      .eq('whatsapp_message_id', wid)
      .maybeSingle()
    if (existe) {
      jaExistiam++
      continue
    }

    const tsNum = m.messageTimestamp ? Number(m.messageTimestamp) : 0
    const criado_em = tsNum > 0 ? new Date(tsNum * 1000).toISOString() : new Date().toISOString()

    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: m.key?.fromMe ? 'out_ia' : 'in',
      conteudo: texto,
      whatsapp_message_id: wid,
      criado_em,
    })
    inseridas++
  }

  return NextResponse.json({
    ok: true,
    telefone,
    encontradas: records.length,
    inseridas,
    jaExistiam,
    ignoradasSemTexto,
  })
}
