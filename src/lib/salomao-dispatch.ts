import { createServerAdminClient } from '@/lib/supabase-server'
import {
  arcaDisparosPendentes, arcaMarcarEnviado,
  arcaMensagensPendentes, arcaMarcarMensagemEnviada,
} from '@/lib/arca'
import { evolutionSendMedia, evolutionSendText } from '@/lib/evolution'
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
// CONCORRÊNCIA: as filas do Arca NÃO têm claim-lock (ao contrário dos convites),
// então dois drenadores simultâneos poderiam enviar o mesmo item duas vezes. Por
// isso o cron é o ÚNICO drenador (o gatilho não envia mais) e uma execução
// termina (≤300s) antes da próxima começar (cron a cada 10 min). Isto é MAIS
// seguro que o desenho antigo, onde um duplo-clique no botão já disparava dois
// after() concorrentes.

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export type ResultadoLeva = {
  pedidos: number   // itens que TENTAMOS enviar nesta leva
  enviados: number
  falhas: number
  erros: string[]
}

const zero = (): ResultadoLeva => ({ pedidos: 0, enviados: 0, falhas: 0, erros: [] })

const espacar = () => sleep(jitterMs(SALOMAO_JITTER_MIN_MS, SALOMAO_JITTER_MAX_MS))

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
      const sent = await evolutionSendMedia(it.whatsapp, {
        media: it.url_boleto,
        fileName: it.nome_arquivo || `${it.aluno || 'boleto'}.pdf`,
        caption: it.mensagem || '',
      })
      await arcaMarcarEnviado(it.id, true)
      out.enviados++
      const wid: string | null = sent?.key?.id ?? null
      await registrarBoletoNoChat(supabase, it, wid)
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

      await arcaMarcarMensagemEnviada(it.id, true)
      out.enviados++
      await registrarDisparoNoChat(supabase, it, wid)
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
