import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { enviarTextoCloud, enviarTextoCloudConta, baixarMidiaCloud } from '@/lib/whatsapp-cloud'
import { interpretarMidia } from '@/lib/midia'
import { registrarAlerta } from '@/lib/alertas'
import { processarMensagemRecebida, type EnviarTexto } from '@/lib/atendimento'

// Folga para baixar mídia + transcrever/descrever antes de responder.
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const vt = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim()
  if (p.get('hub.mode') === 'subscribe' && vt !== '' && (p.get('hub.verify_token') || '').trim() === vt) {
    return new NextResponse(p.get('hub.challenge') || '', { status: 200 })
  }
  return new NextResponse('forbidden', { status: 403 })
}

export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()
  try {
    const body = await req.json()
    const value = body?.entry?.[0]?.changes?.[0]?.value
    const phoneNumberId: string = value?.metadata?.phone_number_id || ''

    const { data: conta } = await supabase
      .from('whatsapp_contas')
      .select('phone_number_id, token')
      .eq('phone_number_id', phoneNumberId)
      .eq('ativo', true)
      .maybeSingle()

    const msg = value?.messages?.[0]
    if (!msg) return NextResponse.json({ ignored: true })

    const telefone: string = msg.from
    const pushName: string = value?.contacts?.[0]?.profile?.name || 'Família'
    const wid: string = msg.id || ''
    const token: string = conta?.token || process.env.WHATSAPP_CLOUD_TOKEN || ''

    // Texto, áudio (transcrição) ou imagem (visão). Outros tipos são ignorados.
    let conteudo = ''
    if (msg.type === 'text') {
      conteudo = msg.text?.body || ''
    } else if (msg.type === 'audio' && msg.audio?.id && token) {
      const m = await baixarMidiaCloud(msg.audio.id, token)
      conteudo = m
        ? await interpretarMidia('audio', m.base64, m.mimetype)
        : '[O responsável enviou um áudio, mas não consegui baixá-lo. Peça, com gentileza, que repita por texto.]'
    } else if (msg.type === 'image' && msg.image?.id && token) {
      const m = await baixarMidiaCloud(msg.image.id, token)
      conteudo = m
        ? await interpretarMidia('imagem', m.base64, m.mimetype, msg.image?.caption)
        : '[O responsável enviou uma imagem, mas não consegui abri-la. Peça, com gentileza, que reenvie ou descreva por texto.]'
    } else {
      return NextResponse.json({ ignored: `tipo ${msg.type}` })
    }

    // Envio pelo canal Cloud (conta específica ou fallback do env)
    const enviarCloud: EnviarTexto = async (tel, txt) => {
      try {
        const sent = conta?.token
          ? await enviarTextoCloudConta(conta.phone_number_id, conta.token, tel, txt)
          : await enviarTextoCloud(tel, txt)
        return sent?.messages?.[0]?.id || null
      } catch (err) {
        console.error('[whatsapp-cloud] envio falhou:', err instanceof Error ? err.message : String(err))
        return null
      }
    }

    // Atribuição: a API oficial traz o objeto "referral" em mensagens de anúncio CTWA
    const ref = msg.referral || null

    await processarMensagemRecebida(supabase, {
      telefone,
      conteudo,
      pushName,
      wid,
      origem: 'whatsapp-oficial',
      tag: 'whatsapp-oficial',
      enviarTexto: enviarCloud,
      canal: ref ? 'meta-ads' : 'organico',
      campanha: ref ? ref.headline || ref.source_id || null : null,
      referral: ref || null,
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    const emsg = e instanceof Error ? e.message : String(e)
    console.error('whatsapp-cloud webhook erro:', emsg)
    await registrarAlerta(supabase, 'webhook/whatsapp-cloud', emsg)
    return NextResponse.json({ ok: false })
  }
}
