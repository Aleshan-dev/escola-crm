// Entrada dos webhooks de WhatsApp: autenticação da origem e trilha bruta
// (crm.webhook_eventos: ingerido | duplicado | descartado | rejeitado | erro).

import { createHmac, timingSafeEqual } from 'crypto'
import type { createServerAdminClient } from '@/lib/supabase-server'
import type { Canal } from './tipos'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export type ResultadoWebhook = 'ingerido' | 'duplicado' | 'descartado' | 'rejeitado' | 'erro'

/**
 * Confere `X-Hub-Signature-256` da Meta: HMAC-SHA256 do corpo BRUTO com o app
 * secret. Comparação em tempo constante.
 */
export function assinaturaMetaValida(corpoBruto: string, cabecalho: string | null, segredo: string): boolean {
  if (!cabecalho?.startsWith('sha256=')) return false
  const esperado = Buffer.from(createHmac('sha256', segredo).update(corpoBruto, 'utf8').digest('hex'))
  const recebido = Buffer.from(cabecalho.slice('sha256='.length))
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido)
}

/** Segredo compartilhado (query `?secret=` ou cabeçalho) em tempo constante. */
export function segredoConfere(recebido: string | null, segredo: string): boolean {
  if (!recebido) return false
  const a = Buffer.from(recebido)
  const b = Buffer.from(segredo)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A conexão que o evento diz ser (sessão WAHA / instância Evolution) é a nossa?
 * Evento sem o campo passa (formato antigo); evento de OUTRA conexão não — senão
 * a mensagem entra na conversa errada e a resposta sai pelo número errado.
 */
export function conexaoConfere(doEvento: unknown, configurada: string | null | undefined): boolean {
  if (typeof doEvento !== 'string' || !doEvento) return true
  if (!configurada) return true
  return doEvento === configurada
}

/** Grava um evento na trilha. Nunca lança: a trilha não pode derrubar a entrada. */
export async function registrarWebhook(
  supabase: SupaAdmin,
  ev: {
    canal: Canal
    canalRef?: string | null
    evento?: string | null
    externalId?: string | null
    resultado: ResultadoWebhook
    detalhe?: string | null
    payload?: unknown
  },
): Promise<void> {
  try {
    const { error } = await supabase.from('webhook_eventos').insert({
      canal: ev.canal,
      canal_ref: ev.canalRef ?? null,
      evento: ev.evento ?? null,
      external_id: ev.externalId || null,
      resultado: ev.resultado,
      detalhe: ev.detalhe?.slice(0, 500) ?? null,
      payload: (ev.payload as object | null) ?? null,
    })
    if (error) console.error('[webhook_eventos] insert falhou:', error.message)
  } catch (e) {
    console.error('[webhook_eventos] insert falhou:', e instanceof Error ? e.message : e)
  }
}

/** Traduz o retorno de processarMensagemRecebida/registrarMensagemManual para a trilha. */
export function resultadoDaIngestao(status: string): { resultado: ResultadoWebhook; detalhe: string } {
  if (status === 'duplicada_ignorada' || status === 'fromMe_sara') return { resultado: 'duplicado', detalhe: status }
  if (status === 'fromMe_sem_familia' || status === 'fromMe_sem_lead') return { resultado: 'descartado', detalhe: status }
  return { resultado: 'ingerido', detalhe: status }
}
