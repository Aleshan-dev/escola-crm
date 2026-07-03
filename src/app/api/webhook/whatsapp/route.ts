import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { cleanWhatsappJid, evolutionSendText } from '@/lib/evolution'
import { registrarAlerta } from '@/lib/alertas'
import {
  processarMensagemRecebida,
  registrarMensagemManual,
  type EnviarTexto,
} from '@/lib/atendimento'
import { extrairConteudoMidia } from '@/lib/midia'

// Dá folga para baixar mídia + transcrever/descrever antes de responder.
export const maxDuration = 30

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook escola-crm online' })
}

const enviarEvolution: EnviarTexto = async (telefone, texto) => {
  const sent = await evolutionSendText(telefone, texto)
  return sent?.key?.id || null
}

export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()

  try {
    const body = await req.json()
    const event = body.event
    const data = body.data

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
        '[mídia ou tipo não suportado ainda]'
    }

    // Atribuição: mensagem vinda de anúncio click-to-WhatsApp traz o "externalAdReply"
    const ad =
      data?.message?.extendedTextMessage?.contextInfo?.externalAdReply ||
      data?.contextInfo?.externalAdReply ||
      null

    await processarMensagemRecebida(supabase, {
      telefone,
      conteudo,
      pushName,
      wid,
      origem: 'whatsapp',
      tag: 'whatsapp',
      enviarTexto: enviarEvolution,
      canal: ad ? 'meta-ads' : 'organico',
      campanha: ad ? ad.title || ad.sourceId || null : null,
      referral: ad || null,
    })

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('Webhook error:', e)
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    await registrarAlerta(supabase, 'webhook/whatsapp', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
