import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { getWahaConfig } from '@/lib/waha'
import { cleanWhatsappJid } from '@/lib/evolution'
import { telefoneFormatoWhatsApp } from '@/lib/boletos'
import { normalizarCelularBR } from '@/lib/sgei'

// Backfill do histórico do WAHA para a tabela `mensagens` — recupera mensagens
// que chegaram enquanto o webhook de entrada ainda não existia.
//
// SEGURO POR DESENHO:
//   - modo PREVIEW por padrão (só lê e relata; ?commit=1 para gravar);
//   - dedupe por whatsapp_message_id (re-rodar não duplica);
//   - grava com a DATA ORIGINAL da mensagem (criado_em);
//   - NÃO aciona Sara/Salomão (insere direto, sem processarMensagemRecebida);
//   - só grava para contatos que JÁ são família/lead (a menos que ?criarLeads=1).
//
// Protegido por CRON_SECRET (Bearer/?secret=) ou sessão logada (botão da UI).
// Params: ?desde=YYYY-MM-DD (Acre, default 2026-09-12) ?telefone=... (opcional,
//         1 contato) ?commit=1 ?criarLeads=1 ?limitePorChat=200

export const maxDuration = 300
export const dynamic = 'force-dynamic'

/* eslint-disable @typescript-eslint/no-explicit-any */

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

type WahaMsg = {
  id?: unknown
  timestamp?: number
  from?: string
  fromMe?: boolean
  body?: string
  hasMedia?: boolean
}

function widDe(id: unknown): string {
  if (!id) return ''
  if (typeof id === 'string') return id
  const o = id as { _serialized?: string; id?: string }
  return o._serialized || o.id || ''
}

async function wahaGet(url: string, key: string, path: string): Promise<any> {
  const r = await fetch(`${url}${path}`, { headers: { 'X-Api-Key': key }, cache: 'no-store' })
  if (!r.ok) throw new Error(`WAHA ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

export async function GET(req: NextRequest) {
  if (!(await autorizado(req))) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const desdeStr = sp.get('desde') || '2026-09-12'
  const commit = sp.get('commit') === '1'
  const limitePorChat = Math.min(Number(sp.get('limitePorChat')) || 200, 1000)
  const telefoneFiltro = (sp.get('telefone') || '').replace(/\D/g, '')

  // 00:00 de Acre (UTC-5) do dia informado.
  const desdeMs = new Date(`${desdeStr}T05:00:00Z`).getTime()
  if (Number.isNaN(desdeMs)) {
    return NextResponse.json({ error: 'desde inválido (use YYYY-MM-DD)' }, { status: 400 })
  }

  const { url, key, session } = await getWahaConfig()
  if (!url || !key) {
    return NextResponse.json({ error: 'WAHA não configurado' }, { status: 400 })
  }

  // 1. Descobre os chats a varrer.
  let chatIds: string[] = []
  try {
    if (telefoneFiltro) {
      chatIds = [`${telefoneFiltro}@c.us`]
    } else {
      // overview traz id + timestamp da última msg (para pular chats inativos).
      let overview: any = null
      try {
        overview = await wahaGet(url, key, `/api/${encodeURIComponent(session)}/chats/overview?limit=500`)
      } catch {
        overview = null
      }
      if (Array.isArray(overview)) {
        chatIds = overview
          .filter((c: any) => {
            const ts = (c?.lastMessage?.timestamp || c?.timestamp || 0) * 1000
            return !ts || ts >= desdeMs // sem timestamp: não descarta, varre e filtra depois
          })
          .map((c: any) => (typeof c === 'string' ? c : c?.id))
          .filter(Boolean)
      } else {
        // Fallback: lista simples de ids.
        const chats = await wahaGet(url, key, `/api/${encodeURIComponent(session)}/chats?limit=500`)
        chatIds = (Array.isArray(chats) ? chats : []).map((c: any) => (typeof c === 'string' ? c : c?.id)).filter(Boolean)
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: 'Falha ao listar chats do WAHA', detalhe: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    )
  }

  // Ignora grupos/status/newsletter.
  chatIds = chatIds.filter((id) => id.endsWith('@c.us'))

  const supabase = createServerAdminClient()

  const res = {
    modo: commit ? 'commit' : 'preview',
    desde: desdeStr,
    chatsVarridos: 0,
    encontradasNaJanela: 0,
    inseridas: 0,
    inseriria: 0,
    jaExistiam: 0,
    semTexto: 0,
    semLead: [] as { telefone: string; qtd: number }[],
    erros: [] as string[],
  }
  const semLeadMap = new Map<string, number>()

  // Casa família invariante ao 9º dígito (mesma convenção de boletos.ts):
  // por telefone no formato WhatsApp OU por sufixo de 8 dígitos do assinante.
  const leadCache = new Map<string, string | null>()
  async function resolverLead(rawPhone: string): Promise<string | null> {
    const telefoneWA = telefoneFormatoWhatsApp(rawPhone)
    if (leadCache.has(telefoneWA)) return leadCache.get(telefoneWA)!
    const recon = normalizarCelularBR(rawPhone)
    const last8 = (recon || rawPhone.replace(/\D/g, '')).slice(-8)
    const { data: fam } = await supabase
      .from('familias')
      .select('id')
      .or(`telefone.eq.${telefoneWA},telefone.ilike.*${last8}`)
      .order('ja_responsavel', { ascending: false })
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    let leadId: string | null = null
    if (fam) {
      const { data: lead } = await supabase
        .from('leads').select('id').eq('familia_id', fam.id)
        .order('criado_em', { ascending: false }).limit(1).maybeSingle()
      leadId = lead?.id ?? null
    }
    leadCache.set(telefoneWA, leadId)
    return leadId
  }

  for (const chatId of chatIds) {
    let msgs: WahaMsg[] = []
    try {
      const raw = await wahaGet(
        url, key,
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?limit=${limitePorChat}&downloadMedia=false`
      )
      msgs = Array.isArray(raw) ? raw : []
    } catch (e) {
      res.erros.push(`${chatId}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    res.chatsVarridos++

    for (const m of msgs) {
      const tsMs = (m.timestamp || 0) * 1000
      if (!tsMs || tsMs < desdeMs) continue
      res.encontradasNaJanela++

      const wid = widDe(m.id)
      const texto = (m.body || '').trim()
      const conteudo = texto || (m.hasMedia
        ? '[Mídia recebida no WhatsApp (não recuperada no backfill). Abra o WhatsApp para ver.]'
        : '')
      if (!conteudo || !wid) { res.semTexto++; continue }

      // Telefone vem do ID DO CHAT (@c.us = número real), não do `from` da
      // mensagem — no 1:1 o WhatsApp carimba o remetente como @lid (opaco).
      const telefone = cleanWhatsappJid(chatId)

      const { data: existe } = await supabase
        .from('mensagens').select('id').eq('whatsapp_message_id', wid).maybeSingle()
      if (existe) { res.jaExistiam++; continue }

      const leadId = await resolverLead(telefone)
      if (!leadId) {
        // Sem lead (criarLeads não implementado neste passo por segurança): reporta.
        const chave = telefoneFormatoWhatsApp(telefone)
        semLeadMap.set(chave, (semLeadMap.get(chave) || 0) + 1)
        continue
      }

      if (!commit) { res.inseriria++; continue }

      const criado_em = new Date(tsMs).toISOString()
      const { error } = await supabase.from('mensagens').insert({
        lead_id: leadId,
        direcao: m.fromMe ? 'out_humano' : 'in',
        ...(m.fromMe ? { agente: 'humano', agente_origem: 'conversa' } : { tipo_midia: 'texto' }),
        conteudo,
        whatsapp_message_id: wid,
        criado_em,
      })
      if (error) res.erros.push(`${wid}: ${error.message}`)
      else res.inseridas++
    }
  }

  res.semLead = Array.from(semLeadMap.entries()).map(([telefone, qtd]) => ({ telefone, qtd }))
  return NextResponse.json({ ok: true, ...res })
}
