import { NextRequest, NextResponse, after } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { enviarTextoCloud, enviarTextoCloudConta, baixarMidiaCloud } from '@/lib/whatsapp-cloud'
import { interpretarMidia, salvarMidiaStorage } from '@/lib/midia'
import { registrarAlerta } from '@/lib/alertas'
import { processarMensagemRecebida, registrarMensagemManual, type EnviarTexto } from '@/lib/atendimento'
import { registrarJanela } from '@/lib/janela'

// Folga para baixar mídia + transcrever/descrever + janela de debounce (15s).
export const maxDuration = 60

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
    const change = body?.entry?.[0]?.changes?.[0]
    const field: string = change?.field || ''
    const value = change?.value
    const phoneNumberId: string = value?.metadata?.phone_number_id || ''

    // ── Recibos de entrega (sent → delivered → read → failed) ────────────────
    const statuses = value?.statuses
    if (Array.isArray(statuses) && statuses.length) {
      const MAP: Record<string, string> = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falhou' }
      for (const st of statuses) {
        if (!st?.id || !st?.status) continue
        const upd: Record<string, unknown> = { status: MAP[st.status] || st.status }
        if (st.status === 'failed') {
          upd.erro_envio = st?.errors?.[0]?.title || st?.errors?.[0]?.message || 'falha na entrega'
        }
        await supabase.from('mensagens').update(upd).eq('whatsapp_message_id', st.id)
      }
      return NextResponse.json({ ok: true, statuses: statuses.length })
    }

    // ── CoEx: ECHO — a secretária respondeu pelo APP do celular ──────────────
    // Espelha o comportamento do fromMe do Evolution: registra como out_humano e
    // PAUSA a IA, para a Sara não falar por cima do atendimento humano. Echo é
    // saída (não abre janela de 24h), então NÃO chama registrarJanela.
    const echoes = value?.message_echoes
    if (field === 'smb_message_echoes' || Array.isArray(echoes)) {
      let n = 0
      for (const echo of (echoes ?? [])) {
        const to: string = echo?.to || echo?.recipient_id || ''
        if (!to) continue
        const tipo: string = echo?.type || 'texto'
        const conteudo: string =
          echo?.text?.body ||
          echo?.[tipo]?.caption ||
          (tipo === 'texto' ? '' : `[${tipo}]`)
        try {
          await registrarMensagemManual(supabase, { telefone: to, conteudo: conteudo || '[mensagem]', wid: echo?.id || '' })
          await supabase.from('familias').update({ canal_whatsapp: 'cloud' }).eq('telefone', to)
          n++
        } catch (e) {
          console.error('[whatsapp-cloud] echo falhou:', e instanceof Error ? e.message : e)
        }
      }
      return NextResponse.json({ ok: true, echoes: n })
    }

    // ── CoEx: HISTORY (backfill até 6 meses) — reconhecido ───────────────────
    // O backfill completo em crm.mensagens é uma etapa posterior (não bloqueia o
    // atendimento ao vivo). Acusamos recebimento para a Meta não reenviar.
    if (field === 'history' || Array.isArray(value?.history)) {
      console.log('[whatsapp-cloud] history recebido (backfill adiado):', JSON.stringify(value ?? {}).slice(0, 400))
      return NextResponse.json({ ok: true, history: 'ack' })
    }

    // ── CoEx: sync de contatos — reconhecido ─────────────────────────────────
    if (field === 'smb_app_state_sync') {
      return NextResponse.json({ ok: true, contatos: 'ack' })
    }

    // ── Mensagem RECEBIDA do responsável ─────────────────────────────────────
    const msg = value?.messages?.[0]
    if (!msg) return NextResponse.json({ ignored: true, field: field || 'sem_field' })

    // Conta ativa deste número, COM RETRY. Sob rajada esta consulta às vezes
    // falhava (erro transitório de conexão) ou voltava vazia mesmo com a conta
    // ATIVA no banco; o código lia isso como "canal desativado" e DESCARTAVA a
    // mensagem sem gravar — perda de inbound do lead da Jessica em 11/09 (2 de 4
    // mensagens sumiram, incluindo "Hoje não conseguirei ir"). Repetimos algumas
    // vezes antes de concluir que não há conta.
    let conta: { phone_number_id: string; token: string | null } | null = null
    let contaErro: string | null = null
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const { data, error } = await supabase
        .from('whatsapp_contas')
        .select('phone_number_id, token')
        .eq('phone_number_id', phoneNumberId)
        .eq('ativo', true)
        .maybeSingle()
      if (data) {
        conta = data
        contaErro = null
        break
      }
      contaErro = error?.message ?? null
      if (tentativa < 3) await new Promise((r) => setTimeout(r, 150 * tentativa))
    }

    if (!conta) {
      // Se houve ERRO na consulta, é falha de infraestrutura (não "canal
      // desativado") e PODE ter perdido uma mensagem real — alerta com destaque
      // para conferência humana no aparelho. Se veio vazio SEM erro, o número
      // está de fato desativado (o WhatsApp opera via Evolution).
      const motivo = contaErro
        ? `⚠️ FALHA ao ler a conta do WhatsApp Cloud após 3 tentativas (${contaErro}). POSSÍVEL PERDA de mensagem de ${msg.from} (phone_number_id ${phoneNumberId}) — confira o aparelho e responda manualmente se preciso.`
        : `Mensagem recebida no número Cloud DESATIVADO (phone_number_id ${phoneNumberId}, de ${msg.from}). O canal ativo é o Evolution — verifique se esse número da Meta ainda está divulgado em algum lugar.`
      await registrarAlerta(supabase, 'webhook/whatsapp-cloud', motivo)
      return NextResponse.json({ ignored: contaErro ? 'falha_consulta_conta' : 'canal cloud desativado' })
    }

    const telefone: string = msg.from
    const pushName: string = value?.contacts?.[0]?.profile?.name || 'Família'
    const wid: string = msg.id || ''
    const token: string = conta?.token || process.env.WHATSAPP_CLOUD_TOKEN || ''

    // Recebeu do responsável → renova a janela de 24h (permite texto livre).
    await registrarJanela(supabase, telefone)

    // Texto ou mídia. A mídia é interpretada para a Sara (transcrição/visão) E o
    // arquivo original é salvo no storage, para abrir pelo chat.
    let conteudo = ''
    let tipoMidia = 'texto'
    let urlMidia: string | null = null

    if (msg.type === 'text') {
      conteudo = msg.text?.body || ''
    } else if (msg.type === 'audio' && msg.audio?.id && token) {
      tipoMidia = 'audio'
      const m = await baixarMidiaCloud(msg.audio.id, token)
      if (m) {
        conteudo = await interpretarMidia('audio', m.base64, m.mimetype)
        urlMidia = await salvarMidiaStorage(supabase, { base64: m.base64, mimetype: m.mimetype })
      } else {
        conteudo = '[O responsável enviou um áudio, mas não consegui baixá-lo. Peça, com gentileza, que repita por texto.]'
      }
    } else if (msg.type === 'image' && msg.image?.id && token) {
      tipoMidia = 'imagem'
      const m = await baixarMidiaCloud(msg.image.id, token)
      if (m) {
        conteudo = await interpretarMidia('imagem', m.base64, m.mimetype, msg.image?.caption)
        urlMidia = await salvarMidiaStorage(supabase, { base64: m.base64, mimetype: m.mimetype })
      } else {
        conteudo = '[O responsável enviou uma imagem, mas não consegui abri-la. Peça, com gentileza, que reenvie ou descreva por texto.]'
      }
    } else if (msg.type === 'document' && msg.document?.id && token) {
      tipoMidia = 'documento'
      const m = await baixarMidiaCloud(msg.document.id, token)
      if (m) {
        conteudo = await interpretarMidia('documento', m.base64, m.mimetype, msg.document?.caption, msg.document?.filename)
        urlMidia = await salvarMidiaStorage(supabase, { base64: m.base64, mimetype: m.mimetype, filename: msg.document?.filename })
      } else {
        conteudo = '[O responsável enviou um documento, mas não consegui baixá-lo. Peça, com gentileza, que reenvie ou descreva por texto.]'
      }
    } else if (msg.type === 'video' && msg.video?.id && token) {
      tipoMidia = 'video'
      const m = await baixarMidiaCloud(msg.video.id, token)
      if (m) {
        urlMidia = await salvarMidiaStorage(supabase, { base64: m.base64, mimetype: m.mimetype })
        conteudo = msg.video?.caption
          ? `${msg.video.caption}\n[O responsável enviou um vídeo — abra pelo chat para assistir.]`
          : '[O responsável enviou um vídeo — abra pelo chat para assistir.]'
      } else {
        conteudo = '[O responsável enviou um vídeo, mas não consegui baixá-lo.]'
      }
    } else {
      console.log('[whatsapp-cloud] tipo de mensagem ignorado:', msg.type)
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

    // Responde o webhook na hora e processa em segundo plano (after): a janela de
    // debounce de 15s roda sem segurar a resposta à Meta (evita reenvio/duplicação).
    after(async () => {
      try {
        await processarMensagemRecebida(supabase, {
          telefone,
          conteudo,
          pushName,
          wid,
          origem: 'whatsapp-oficial',
          tag: 'whatsapp-oficial',
          enviarTexto: enviarCloud,
          canalEnvio: 'cloud',
          canal: ref ? 'meta-ads' : 'organico',
          campanha: ref ? ref.headline || ref.source_id || null : null,
          referral: ref || null,
          phoneNumberId,
          tipoMidia,
          urlMidia,
        })
        // Canal do contato = Cloud (o lead escreveu pelo número oficial). Mantém o
        // roteamento de saída seguindo o último canal usado pelo lead.
        await supabase.from('familias').update({ canal_whatsapp: 'cloud' }).eq('telefone', telefone)
      } catch (e) {
        console.error('whatsapp-cloud (after) erro:', e instanceof Error ? e.message : String(e))
        await registrarAlerta(supabase, 'webhook/whatsapp-cloud', e instanceof Error ? e.message : String(e))
      }
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    const emsg = e instanceof Error ? e.message : String(e)
    console.error('whatsapp-cloud webhook erro:', emsg)
    await registrarAlerta(supabase, 'webhook/whatsapp-cloud', emsg)
    return NextResponse.json({ ok: false })
  }
}
