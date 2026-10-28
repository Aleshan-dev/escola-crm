import { NextRequest, NextResponse, after } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { wahaSendText, resolverContatoWaha, getWahaConfig } from '@/lib/waha'
import { registrarAlerta } from '@/lib/alertas'
import {
  processarMensagemRecebida,
  registrarMensagemManual,
  type EnviarTexto,
} from '@/lib/atendimento'
import { extrairConteudoMidiaWaha } from '@/lib/midia'
import { normalizarCelular } from '@/lib/telefone'
import { conexaoConfere, registrarWebhook, resultadoDaIngestao, segredoConfere } from '@/lib/canais/webhook'
import { lerConfigAnuncio, extrairReferralWaha, detectarOrigem } from '@/lib/atribuicao'

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
// Evento de OUTRA sessão WAHA (outro chip) entra no CRM SEM resposta automática:
// a resposta sairia pela sessão configurada, um número diferente do que o lead usou.
// Toda mensagem fica na trilha crm.webhook_eventos (src/lib/canais/webhook.ts).

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
  if (secret && !segredoConfere(new URL(req.url).searchParams.get('secret'), secret)) {
    await registrarWebhook(supabase, { canal: 'waha', resultado: 'rejeitado', detalhe: 'secret inválido' })
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const event: string = body?.event || ''
    const p = body?.payload || {}
    const sessao: string | null = typeof body?.session === 'string' ? body.session : null

    // Evento de OUTRA sessão (outro chip apontando para esta URL, ex.: Salomao-crm):
    // a mensagem entra no CRM, mas SEM IA e sem mudar o canal da conversa — a
    // resposta automática sairia pela sessão configurada, outro número. Vira alerta
    // para a equipe responder pelo próprio chip.
    const { session: sessaoConfigurada } = await getWahaConfig()
    const outraSessao = !conexaoConfere(sessao, sessaoConfigurada)
    const canalRef = sessao || sessaoConfigurada

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
    const trilha = { canal: 'waha' as const, canalRef, evento: event, externalId: widDe(p?.id), payload: body }

    const from: string = p?.from || ''
    // Ignora grupos, status/stories e newsletters (de qualquer sessão, antes de tudo).
    if (!from || from.includes('@g.us') || from.includes('@broadcast') || from.includes('@newsletter')) {
      await registrarWebhook(supabase, { ...trilha, resultado: 'descartado', detalhe: 'grupo/status/sem from' })
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
      await registrarWebhook(supabase, { ...trilha, resultado: 'descartado', detalhe: `LID não resolvido: ${from}` })
      return NextResponse.json({ ignored: 'lid-sem-numero', from })
    }

    const texto: string = p?.body || ''
    const pushName: string = nome || p?.notifyName || p?._data?.notifyName || 'Família'
    const wid = widDe(p?.id)

    // fromMe: mensagem saída do próprio número (Sara via API ou resposta manual no celular).
    if (p?.fromMe === true) {
      const conteudoOut = texto || '[mídia]'
      const status = await registrarMensagemManual(supabase, {
        telefone, conteudo: conteudoOut, wid, canal: 'waha', canalRef, carimbarFamilia: !outraSessao,
      })
      await registrarWebhook(supabase, { ...trilha, ...resultadoDaIngestao(status) })
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

        // Atribuição de origem (anúncio pago × orgânico). Só no chip de ATENDIMENTO:
        // o chip de outra sessão (cobrança) não recebe leads de anúncio. First-touch —
        // processarMensagemRecebida só grava no INSERT da família. Frase-gatilho do
        // anúncio no 1º recado é o sinal confiável no WAHA; o referral CTWA, quando o
        // engine o entrega, é usado como bônus. Ver src/lib/atribuicao.ts.
        let origemLead: { canal: 'meta-ads' | 'organico'; campanha: string | null; referral: unknown } = {
          canal: 'organico', campanha: null, referral: null,
        }
        if (!outraSessao) {
          const cfgAnuncio = await lerConfigAnuncio(supabase)
          origemLead = detectarOrigem({ texto: texto || conteudo, referral: extrairReferralWaha(p), cfg: cfgAnuncio })
        }

        const status = await processarMensagemRecebida(supabase, {
          telefone,
          conteudo,
          pushName,
          wid,
          origem: 'whatsapp',
          tag: 'whatsapp',
          enviarTexto: enviarWaha,
          canalEnvio: 'waha',
          canalRef,
          somenteRegistrar: outraSessao ? { motivo: `o chip WAHA "${sessao}"` } : undefined,
          canal: origemLead.canal,
          campanha: origemLead.campanha,
          referral: origemLead.referral,
          tipoMidia,
          urlMidia,
          // Mensagem citada (responder no WhatsApp) — respostas de Caso da equipe.
          // WAHA traz o id curto em replyTo.id (o motor WEBJS também em _data).
          citadoWid: p?.replyTo?.id || p?._data?.quotedStanzaID || null,
        })
        // O canal do contato (familias.canal_whatsapp = 'waha') é carimbado dentro de
        // processarMensagemRecebida, pela família — não pelo telefone cru (outra
        // sessão não carimba: a conversa continua no canal em que já estava).
        await registrarWebhook(supabase, { ...trilha, ...resultadoDaIngestao(status) })

        // Corrige o nome de leads que ficaram como "Família" (criados antes de
        // termos o nome do WhatsApp). Só sobrescreve o placeholder, nunca um nome real.
        if (nome) {
          await supabase.from('familias')
            .update({ nome_responsavel: nome })
            .eq('telefone_norm', normalizarCelular(telefone))
            .or('nome_responsavel.is.null,nome_responsavel.eq.Família')
        }
      } catch (e) {
        console.error('Webhook WAHA (after) erro:', e)
        await registrarAlerta(supabase, 'webhook/waha', e instanceof Error ? e.message : String(e))
        await registrarWebhook(supabase, { ...trilha, resultado: 'erro', detalhe: e instanceof Error ? e.message : String(e) })
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
