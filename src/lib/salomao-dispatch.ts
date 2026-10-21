import { createServerAdminClient } from '@/lib/supabase-server'
import {
  arcaDisparosPendentes, arcaMarcarEnviado,
  arcaMensagensPendentes, arcaMarcarMensagemEnviada,
} from '@/lib/arca'
import { canalNaoOficial, evolutionSendMedia, evolutionSendText } from '@/lib/evolution'
import { enviarProtegido } from '@/lib/envio/portao'
import { registrarBoletoNoChat } from '@/lib/boletos'
import { registrarDisparoNoChat, mediatypeDe } from '@/lib/disparos'
import {
  MAX_ENVIOS_SALOMAO_POR_EXECUCAO,
  SALOMAO_JITTER_MIN_MS, SALOMAO_JITTER_MAX_MS,
  jitterMs, sleep,
} from '@/lib/pacing'

// Disparo em massa do Salomão (boletos + comunicados), drenado em LEVAS PEQUENAS
// e ESPAÇADAS — o coração do anti-bloqueio do WhatsApp.
//
// POR QUE ISTO EXISTE (mudança de 2026-09-03):
// Antes, o gatilho "Acionar Salomão" enviava a fila inteira (até 50) num único
// after(), com 1–2s entre cada — uma RAJADA. Para o WhatsApp isso é o retrato do
// spam, e o número da escola já foi bloqueado preventivamente uma vez no piloto.
// Agora o gatilho só ENFILEIRA; QUEM ENVIA é o cron /api/cron/salomao-dispatch,
// em levas de no máximo MAX_ENVIOS_SALOMAO_POR_EXECUCAO, com 15–45s entre
// contatos, e SÓ dentro do horário comercial (guarda no chamador). A escola
// inteira sai ao longo do dia, sem bloco.
//
// FRONTEIRA COM O ARCA (igual aos convites): o Arca é dono da máquina de estados
// das filas `boletos_disparo` e `disparos_fila`. O CRM lê o pendente
// (disparos_pendentes / mensagens_pendentes), envia pelo Evolution e devolve o
// resultado (marcar_enviado / marcar_mensagem_enviada). Não escrevemos status à
// mão e não reescrevemos o texto: a mensagem vem PRONTA do Arca.
//
// CONCORRÊNCIA: as filas do Arca NÃO têm claim-lock (ao contrário dos convites).
// Desde 21/10 cada item passa pela trava do lado do CRM (crm.envio_item_claim via
// envio_item_reivindicar): só quem insere a linha envia; item já enviado nunca sai
// de novo, mesmo que o Arca ainda o devolva como pendente. Isso cobre duas
// instâncias DESTE app. Outro sistema drenando a mesma fila (ex.: o deskcomm-staging)
// não usa esta trava — esse precisa ser desligado lá.
//
// PORTÃO DE ENVIO (src/lib/envio): cada destinatário passa por opt-out, janela,
// ritmo e teto do dia do número. Barrado por ritmo/teto = a leva para e o item fica
// pendente no Arca para a próxima rodada; opt-out = marcado como falha no Arca.

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export type ResultadoLeva = {
  pedidos: number   // itens que TENTAMOS enviar nesta leva
  enviados: number
  falhas: number
  erros: string[]
}

const zero = (): ResultadoLeva => ({ pedidos: 0, enviados: 0, falhas: 0, erros: [] })

const espacar = () => sleep(jitterMs(SALOMAO_JITTER_MIN_MS, SALOMAO_JITTER_MAX_MS))

type Passo = { ok: true; wid: string | null } | { ok: false; parar: boolean; motivo: string }

/**
 * Trava o item (uma vez só, entre instâncias) e envia pelo portão de envio.
 * `ok:false, parar:true` = ritmo/teto do número: encerre a leva, o item continua
 * pendente no Arca. `parar:false` = pule só este item. Erro do transporte é
 * relançado (o chamador marca a falha no Arca, como antes).
 * Se a trava em si falhar (banco), segue sem ela — fail-open, como o portão.
 */
async function enviarItem(
  supabase: SupaAdmin,
  fila: 'boletos' | 'disparos',
  itemId: string,
  whatsapp: string,
  texto: string,
  enviar: () => Promise<string | null>,
): Promise<Passo> {
  const { data: travou, error } = await supabase.rpc('envio_item_reivindicar', { p_fila: fila, p_item_id: itemId })
  if (error) console.error('[salomao-dispatch] trava do item falhou (seguindo sem ela):', error.message)
  else if (!travou) return { ok: false, parar: false, motivo: 'ja_reivindicado' }

  const concluir = (sucesso: boolean) =>
    error ? Promise.resolve() : supabase.rpc('envio_item_concluir', { p_fila: fila, p_item_id: itemId, p_sucesso: sucesso }).then(() => {})

  try {
    const r = await enviarProtegido({ origem: 'salomao', canal: canalNaoOficial(), telefone: whatsapp }, texto, enviar)
    if (r.status !== 'enviado') {
      await concluir(false)
      return { ok: false, parar: r.status === 'adiado', motivo: r.motivo }
    }
    await concluir(true)
    return { ok: true, wid: r.wid }
  } catch (e) {
    await concluir(false)
    throw e
  }
}

/**
 * Drena a fila de BOLETOS até `orcamento` envios. Cada item é um PDF com legenda.
 * Espaça 15–45s entre um contato e o próximo (menos depois do último).
 * Uma falha por item nunca derruba os outros. Lança só se a leitura da fila falhar.
 */
export async function drenarBoletosSalomao(
  supabase: SupaAdmin,
  orcamento: number,
): Promise<ResultadoLeva> {
  const out = zero()
  if (orcamento <= 0) return out

  const { items } = await arcaDisparosPendentes(orcamento)
  if (items.length === 0) return out

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    out.pedidos++
    try {
      const passo = await enviarItem(supabase, 'boletos', String(it.id), it.whatsapp, it.mensagem || '', async () => {
        const sent = await evolutionSendMedia(it.whatsapp, {
          media: it.url_boleto,
          fileName: it.nome_arquivo || `${it.aluno || 'boleto'}.pdf`,
          caption: it.mensagem || '',
        })
        return sent?.key?.id ?? null
      })
      if (!passo.ok) {
        out.pedidos--
        if (passo.motivo === 'opt_out') await arcaMarcarEnviado(it.id, false, 'bloqueado pelo CRM: família pediu para parar (opt-out)')
        if (passo.parar) break
        continue
      }
      await arcaMarcarEnviado(it.id, true)
      out.enviados++
      await registrarBoletoNoChat(supabase, it, passo.wid)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      out.falhas++
      out.erros.push(`${it.id}: ${msg.slice(0, 120)}`)
      await arcaMarcarEnviado(it.id, false, msg)
    }
    if (i < items.length - 1) await espacar()
  }
  return out
}

/**
 * Drena a fila de MENSAGENS EM MASSA (comunicados do "Disparo do Salomão") até
 * `orcamento` envios. Regra de anexos (contrato 05/08/2026):
 *   0 anexos = só texto; 1–2 = texto na legenda do 1º anexo; 3+ = texto separado
 *   antes dos arquivos. Espaça 15–45s ENTRE DESTINATÁRIOS (os anexos de um mesmo
 *   destinatário ficam a 0,7–1,4s, que é conversa, não rajada em massa).
 */
export async function drenarMensagensSalomao(
  supabase: SupaAdmin,
  orcamento: number,
): Promise<ResultadoLeva> {
  const out = zero()
  if (orcamento <= 0) return out

  const { items } = await arcaMensagensPendentes(orcamento)
  if (items.length === 0) return out

  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    out.pedidos++
    try {
      const n = it.anexos.length
      const passo = await enviarItem(supabase, 'disparos', String(it.id), it.whatsapp, it.mensagem || '', async () => {
        let wid: string | null = null

        if (n === 0) {
          const sent = await evolutionSendText(it.whatsapp, it.mensagem)
          wid = sent?.key?.id ?? null
        } else if (n <= 2) {
          for (let k = 0; k < n; k++) {
            const a = it.anexos[k]
            const sent = await evolutionSendMedia(it.whatsapp, {
              media: a.url,
              fileName: a.nome,
              caption: k === 0 ? it.mensagem : '',
              mediatype: mediatypeDe(a.mime),
              mimetype: a.mime,
            })
            if (k === 0) wid = sent?.key?.id ?? null
            if (k < n - 1) await sleep(jitterMs(700, 1400))
          }
        } else {
          const sent = await evolutionSendText(it.whatsapp, it.mensagem)
          wid = sent?.key?.id ?? null
          for (let k = 0; k < n; k++) {
            const a = it.anexos[k]
            await sleep(jitterMs(700, 1400))
            await evolutionSendMedia(it.whatsapp, {
              media: a.url,
              fileName: a.nome,
              caption: '',
              mediatype: mediatypeDe(a.mime),
              mimetype: a.mime,
            })
          }
        }
        return wid
      })
      if (!passo.ok) {
        out.pedidos--
        if (passo.motivo === 'opt_out') await arcaMarcarMensagemEnviada(it.id, false, 'bloqueado pelo CRM: família pediu para parar (opt-out)')
        if (passo.parar) break
        continue
      }

      await arcaMarcarMensagemEnviada(it.id, true)
      out.enviados++
      await registrarDisparoNoChat(supabase, it, passo.wid)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      out.falhas++
      out.erros.push(`${it.id}: ${msg.slice(0, 120)}`)
      await arcaMarcarMensagemEnviada(it.id, false, msg)
    }
    if (i < items.length - 1) await espacar()
  }
  return out
}

/**
 * Uma leva do Salomão: gasta UM orçamento compartilhado (boletos primeiro, o
 * resto para as mensagens), para o total de envios da execução respeitar o teto
 * MAX_ENVIOS_SALOMAO_POR_EXECUCAO — senão boletos + comunicados juntos formariam
 * uma leva do dobro do tamanho e estourariam o tempo/rajada.
 *
 * O chamador (gatilho ou cron) já validou horário comercial e config.
 */
export async function drenarSalomao(
  orcamentoTotal = MAX_ENVIOS_SALOMAO_POR_EXECUCAO,
): Promise<{ boletos: ResultadoLeva; mensagens: ResultadoLeva }> {
  const supabase = createServerAdminClient()

  const boletos = await drenarBoletosSalomao(supabase, orcamentoTotal)
  const restante = orcamentoTotal - boletos.enviados
  // Espaça também a TRANSIÇÃO boleto→mensagem: são o mesmo número enviando.
  if (boletos.enviados > 0 && restante > 0) await espacar()
  const mensagens = await drenarMensagensSalomao(supabase, restante)

  return { boletos, mensagens }
}
