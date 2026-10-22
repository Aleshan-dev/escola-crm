import { NextRequest, NextResponse, after } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { canalNaoOficial, cleanWhatsappJid, evolutionSendText } from '@/lib/evolution'
import { registrarAlerta } from '@/lib/alertas'
import {
  processarMensagemRecebida,
  registrarMensagemManual,
  type EnviarTexto,
} from '@/lib/atendimento'
import { extrairConteudoMidia } from '@/lib/midia'

// Dá folga para baixar mídia + transcrever/descrever + janela de debounce (15s).
export const maxDuration = 60

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook escola-crm online' })
}

const enviarEvolution: EnviarTexto = async (telefone, texto) => {
  const sent = await evolutionSendText(telefone, texto)
  return sent?.key?.id || null
}

// Ordem de progressão: só avançamos, nunca voltamos. 'falhou' é o topo (um sinal
// de erro não deve ser desfeito por um recibo tardio de entrega).
const RANK_STATUS: Record<string, number> = { enviado: 1, entregue: 2, lido: 3, falhou: 4 }

// Traduz o status bruto do canal não-oficial para o nosso vocabulário. Prefere os
// RÓTULOS em texto (iguais nos dois provedores); só cai no numérico quando não há
// rótulo — e aí o mapa depende do provedor, porque os códigos divergem:
//   Evolution/Baileys (messages.update): 0 ERROR · 1 PENDING · 2 SERVER · 3 DELIVERY · 4 READ · 5 PLAYED
//   WAHA (message.ack):                 -1 ERROR · 0 PENDING · 1 SERVER · 2 DEVICE  · 3 READ · 4 PLAYED
// Retorna null para estados que não mapeiam (ex.: PENDING) — aí não mexemos na linha.
function mapStatusNaoOficial(event: string, raw: unknown): 'enviado' | 'entregue' | 'lido' | 'falhou' | null {
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase()
    if (s === 'SERVER_ACK' || s === 'SENT') return 'enviado'
    if (s === 'DELIVERY_ACK' || s === 'DELIVERED' || s === 'DEVICE') return 'entregue'
    if (s === 'READ' || s === 'PLAYED') return 'lido'
    if (s === 'ERROR' || s === 'FAILED') return 'falhou'
    // string numérica ("3") cai no tratamento numérico abaixo
    if (!/^-?\d+$/.test(s)) return null
    raw = Number(s)
  }
  if (typeof raw !== 'number') return null
  const waha = event === 'message.ack'
  if (waha) {
    if (raw === -1) return 'falhou'
    if (raw === 1) return 'enviado'
    if (raw === 2) return 'entregue'
    if (raw >= 3) return 'lido'
    return null // 0 = PENDING
  }
  // Evolution/Baileys
  if (raw === 0) return 'falhou'
  if (raw === 2) return 'enviado'
  if (raw === 3) return 'entregue'
  if (raw >= 4) return 'lido'
  return null // 1 = PENDING
}

type SupaAdmin = ReturnType<typeof createServerAdminClient>

// Atualiza o status de cada mensagem citada no evento de recibo, sem rebaixar.
async function processarStatusNaoOficial(supabase: SupaAdmin, event: string, data: unknown): Promise<number> {
  const itens = Array.isArray(data) ? data : [data]
  let aplicados = 0
  for (const it of itens) {
    const item = it as {
      key?: { id?: string }
      keyId?: string
      id?: string
      status?: unknown
      ack?: unknown
      update?: { status?: unknown }
    } | null
    if (!item) continue
    const wid: string = item.key?.id || item.keyId || item.id || ''
    if (!wid) continue
    const bruto = item.update?.status ?? item.status ?? item.ack
    const novo = mapStatusNaoOficial(event, bruto)
    if (!novo) continue

    // Lê o status atual só para não rebaixar (linha pode nem existir → ignora).
    const { data: atual } = await supabase
      .from('mensagens')
      .select('status')
      .eq('whatsapp_message_id', wid)
      .maybeSingle<{ status: string }>()
    if (!atual) continue
    if ((RANK_STATUS[novo] || 0) <= (RANK_STATUS[atual.status] || 0)) continue

    await supabase.from('mensagens').update({ status: novo }).eq('whatsapp_message_id', wid)
    aplicados++
  }
  return aplicados
}

export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()

  try {
    const body = await req.json()
    const event = body.event
    const data = body.data

    // ── Recibos de entrega (canal não-oficial) ───────────────────────────────
    // Evolution emite `messages.update`; o WAHA emite `message.ack`. Ambos passam
    // por este mesmo webhook (o provider é escolhido pela env WHATSAPP_PROVIDER).
    // Atualizamos crm.mensagens.status por whatsapp_message_id, sem NUNCA rebaixar
    // (um 'entregue' atrasado não desfaz um 'lido').
    if (event === 'messages.update' || event === 'MESSAGES_UPDATE' || event === 'message.ack') {
      const n = await processarStatusNaoOficial(supabase, event, data)
      return NextResponse.json({ ok: true, status: n })
    }

    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return NextResponse.json({ ignored: event })
    }

    const jid: string = data?.key?.remoteJid || ''
    if (!jid || jid.includes('@g.us')) return NextResponse.json({ ignored: 'group ou sem jid' })

    const telefone = cleanWhatsappJid(jid)
    const texto: string =
      data?.message?.conversation ||
      data?.message?.extendedTextMessage?.text ||
      ''
    const pushName: string = data?.pushName || 'Família'
    const wid: string = data?.key?.id || ''

    // fromMe: mensagem enviada pelo próprio número (Sara via API ou manual pelo celular)
    if (data?.key?.fromMe === true) {
      const conteudoOut = texto || data?.message?.imageMessage?.caption || '[mídia]'
      const status = await registrarMensagemManual(supabase, { telefone, conteudo: conteudoOut, wid })
      return NextResponse.json({ ok: true, fromMe: status })
    }

    // Mensagem recebida: se não veio texto, tenta interpretar áudio/imagem.
    let conteudo = texto
    if (!conteudo) {
      conteudo =
        (await extrairConteudoMidia(data)) ||
        data?.message?.imageMessage?.caption ||
        // Mídia que não conseguimos ler (figurinha, reação, imagem sem legenda,
        // áudio/tipo não suportado). Instrui a IA em vez de deixar um placeholder
        // vago — senão ela chuta pelo histórico (ex.: tratou uma reação ao post do
        // Dia dos Pais como "comprovante de pagamento").
        '[O responsável enviou uma mídia que não consigo abrir por aqui (figurinha, reação, imagem sem legenda, áudio ou tipo não suportado). Agradeça com gentileza e, se parecer importante, peça para reenviar como texto ou foto. NÃO presuma o assunto — em especial, NÃO trate como comprovante de pagamento.]'
    }

    // Atribuição: mensagem vinda de anúncio click-to-WhatsApp traz o "externalAdReply"
    const ad =
      data?.message?.extendedTextMessage?.contextInfo?.externalAdReply ||
      data?.contextInfo?.externalAdReply ||
      null

    // Responde o webhook na hora e processa em segundo plano (after): a janela de
    // debounce de 15s roda sem segurar a resposta ao Evolution (evita reenvio).
    after(async () => {
      try {
        await processarMensagemRecebida(supabase, {
          telefone,
          conteudo,
          pushName,
          wid,
          origem: 'whatsapp',
          tag: 'whatsapp',
          enviarTexto: enviarEvolution,
          canalEnvio: canalNaoOficial(),
          canal: ad ? 'meta-ads' : 'organico',
          campanha: ad ? ad.title || ad.sourceId || null : null,
          referral: ad || null,
          // Mensagem citada (responder no WhatsApp) — respostas de Caso da equipe.
          citadoWid:
            data?.message?.extendedTextMessage?.contextInfo?.stanzaId ||
            data?.contextInfo?.stanzaId ||
            null,
        })
      } catch (e) {
        console.error('Webhook (after) erro:', e)
        await registrarAlerta(supabase, 'webhook/whatsapp', e instanceof Error ? e.message : String(e))
      }
    })

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('Webhook error:', e)
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    await registrarAlerta(supabase, 'webhook/whatsapp', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
