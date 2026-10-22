import { NextRequest, NextResponse, after } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { wahaSendText, resolverContatoWaha } from '@/lib/waha'
import { registrarAlerta } from '@/lib/alertas'
import {
  processarMensagemRecebida,
  registrarMensagemManual,
  type EnviarTexto,
} from '@/lib/atendimento'
import { extrairConteudoMidiaWaha } from '@/lib/midia'

// Webhook de ENTRADA do WAHA (canal de disparos). Espelha o /api/webhook/whatsapp
// (Evolution), mas no formato de eventos do WAHA:
//   { event: 'message' | 'message.any', session, payload: { from, body, fromMe, id, notifyName, hasMedia, media } }
//
// - 'message'      = recebidas (fromMe=false)
// - 'message.any'  = inclui as enviadas pelo próprio número (fromMe=true), p/ capturar
//                    respostas manuais feitas do celular (ADR-005). Dedupe por wid.
//
// A resposta (Sara) sai pelo PRÓPRIO WAHA (wahaSendText), não pela flag — a
// mensagem chegou neste número, então responde por ele.
//
// Registro do webhook no WAHA: ver /api/waha/webhook-register (ou o botão na tela).
// Middleware libera /api/webhook/* sem sessão; opcionalmente exige ?secret=<WAHA_WEBHOOK_SECRET>.

export const maxDuration = 60

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook WAHA online' })
}

const enviarWaha: EnviarTexto = async (telefone, texto) => {
  const sent = await wahaSendText(telefone, texto)
  return sent?.key?.id || null
}

// id da mensagem no webhook do WAHA: string, ou objeto com _serialized.
function widDe(id: unknown): string {
  if (!id) return ''
  if (typeof id === 'string') return id
  const o = id as { _serialized?: string; id?: string }
  return o._serialized || o.id || ''
}

export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()

  // Segurança opcional: se WAHA_WEBHOOK_SECRET existir, exige ?secret= na URL.
  const secret = process.env.WAHA_WEBHOOK_SECRET
  if (secret && new URL(req.url).searchParams.get('secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const event: string = body?.event || ''
    const p = body?.payload || {}

    // ── Recibos de entrega (ack): entregue (✓✓) / lido (✓✓ azul) ──────────────
    // O WAHA emite 'message.ack' para as mensagens que ENVIAMOS. Níveis:
    //   -1 ERROR · 0 PENDING · 1 SERVER(enviado) · 2 DEVICE(entregue) · 3 READ(lido) · 4 PLAYED
    // Casa pelo id (_serialized) gravado em whatsapp_message_id e NUNCA rebaixa um
    // status já mais avançado — acks podem chegar fora de ordem.
    if (event === 'message.ack') {
      const wid = widDe(p?.id)
      const ack = Number(p?.ack)
      let novo: 'entregue' | 'lido' | 'falhou' | null = null
      let de: string[] = []
      if (ack === -1) { novo = 'falhou'; de = ['enviado'] }
      else if (ack >= 3) { novo = 'lido'; de = ['enviado', 'entregue'] }
      else if (ack === 2) { novo = 'entregue'; de = ['enviado'] }
      if (!wid || !novo) {
        return NextResponse.json({ ok: true, ack, ignored: !wid ? 'ack sem id' : 'nivel sem mudanca' })
      }
      const upd: Record<string, unknown> = { status: novo }
      if (novo === 'falhou') upd.erro_envio = 'Falha na entrega (WAHA)'
      await supabase
        .from('mensagens')
        .update(upd)
        .eq('whatsapp_message_id', wid)
        .or(`status.is.null,status.in.(${de.join(',')})`)
      return NextResponse.json({ ok: true, ack, status: novo })
    }

    if (event !== 'message' && event !== 'message.any') {
      return NextResponse.json({ ignored: event })
    }

    const from: string = p?.from || ''
    // Ignora grupos, status/stories e newsletters.
    if (!from || from.includes('@g.us') || from.includes('@broadcast') || from.includes('@newsletter')) {
      return NextResponse.json({ ignored: 'grupo/status/sem from' })
    }

    // Resolve o contato: telefone real + nome do WhatsApp. O `from` pode vir como
    // @lid (sem telefone e sem nome no payload) — o resolver pergunta ao WAHA.
    // Conserta casamento de família, destino da resposta E o nome do lead.
    const { telefone, nome } = await resolverContatoWaha(from)

    // Sem número real (um @lid que o WAHA não conseguiu mapear): NÃO cria família
    // nem grava mensagem. Usar o LID como "telefone" misturava conversas de pessoas
    // diferentes e criava contatos-fantasma. Registra alerta para reprocesso manual.
    if (!telefone) {
      await registrarAlerta(supabase, 'webhook/waha', `LID não resolvido para número: ${from}`)
      return NextResponse.json({ ignored: 'lid-sem-numero', from })
    }

    const texto: string = p?.body || ''
    const pushName: string = nome || p?.notifyName || p?._data?.notifyName || 'Família'
    const wid = widDe(p?.id)

    // fromMe: mensagem saída do próprio número (Sara via API ou resposta manual no celular).
    if (p?.fromMe === true) {
      const conteudoOut = texto || '[mídia]'
      const status = await registrarMensagemManual(supabase, { telefone, conteudo: conteudoOut, wid })
      await supabase.from('familias').update({ canal_whatsapp: 'waha' }).eq('telefone', telefone)
      return NextResponse.json({ ok: true, fromMe: status })
    }

    // Responde o webhook na hora; processa em segundo plano (baixar/transcrever
    // mídia + debounce de 15s rodam sem segurar a resposta ao WAHA, evitando retry).
    after(async () => {
      try {
        let conteudo = texto
        let tipoMidia = 'texto'
        let urlMidia: string | null = null

        // Mídia: baixa do WAHA, salva no storage e interpreta (áudio→transcrição,
        // imagem→descrição). O caption entra junto do texto interpretado.
        if (p?.hasMedia) {
          const m = await extrairConteudoMidiaWaha(p)
          if (m) { conteudo = m.conteudo; tipoMidia = m.tipoMidia; urlMidia = m.urlMidia }
        }
        if (!conteudo) {
          conteudo =
            '[O responsável enviou uma mídia que não consigo abrir por aqui. Agradeça com gentileza e, se parecer importante, peça para reenviar como texto. NÃO presuma o assunto — em especial, NÃO trate como comprovante de pagamento.]'
        }

        await processarMensagemRecebida(supabase, {
          telefone,
          conteudo,
          pushName,
          wid,
          origem: 'whatsapp',
          tag: 'whatsapp',
          enviarTexto: enviarWaha,
          canalEnvio: 'waha',
          canal: 'organico',
          tipoMidia,
          urlMidia,
        })
        // Marca o canal do contato: a saída (manual e automática) deve sair pelo
        // WAHA — o mesmo número onde o lead escreveu. (Diferente do `canal` acima,
        // que é atribuição de marketing.)
        await supabase.from('familias').update({ canal_whatsapp: 'waha' }).eq('telefone', telefone)

        // Corrige o nome de leads que ficaram como "Família" (criados antes de
        // termos o nome do WhatsApp). Só sobrescreve o placeholder, nunca um nome real.
        if (nome) {
          await supabase.from('familias')
            .update({ nome_responsavel: nome })
            .eq('telefone', telefone)
            .or('nome_responsavel.is.null,nome_responsavel.eq.Família')
        }
      } catch (e) {
        console.error('Webhook WAHA (after) erro:', e)
        await registrarAlerta(supabase, 'webhook/waha', e instanceof Error ? e.message : String(e))
      }
    })

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('Webhook WAHA error:', e)
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    await registrarAlerta(supabase, 'webhook/waha', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
