// REGISTRY DE ADAPTERS — um por canal físico, fail-closed.
//
// Cada adapter só embrulha o transporte que já existia (waha.ts, whatsapp-cloud.ts,
// evolution.ts). `adapterDe` LANÇA para canal desconhecido: nunca converte um
// canal que não conhece em outro "padrão".

import { classificarMidia, type MidiaSaida } from '@/lib/whatsapp-cloud'
import { CanalIndisponivelError, ehCanal, type Canal, type EstadoCanais } from './tipos'

export interface AdapterCanal {
  canal: Canal
  /** Envia texto; devolve o id da mensagem no provedor (wid) ou null. */
  enviarTexto(to: string, texto: string, estado: EstadoCanais): Promise<string | null>
  /** Envia mídia; devolve o wid ou null. */
  enviarMidia(to: string, midia: MidiaSaida, estado: EstadoCanais): Promise<string | null>
}

const waha: AdapterCanal = {
  canal: 'waha',
  async enviarTexto(to, texto) {
    const { wahaSendText } = await import('@/lib/waha')
    return (await wahaSendText(to, texto))?.key?.id || null
  },
  async enviarMidia(to, midia) {
    if (!midia.url) throw new Error('Envio de mídia por WAHA requer URL da mídia')
    const { wahaSendMedia } = await import('@/lib/waha')
    const sent = await wahaSendMedia(to, {
      media: midia.url, fileName: midia.filename, caption: midia.caption,
      mediatype: classificarMidia(midia.mimetype).kind, mimetype: midia.mimetype,
    })
    return sent?.key?.id || null
  },
}

const cloud: AdapterCanal = {
  canal: 'cloud',
  async enviarTexto(to, texto, estado) {
    if (!estado.cloud) throw new CanalIndisponivelError('cloud', 'nenhuma conta Cloud ativa')
    const { enviarTextoCloudConta } = await import('@/lib/whatsapp-cloud')
    const sent = await enviarTextoCloudConta(estado.cloud.phoneNumberId, estado.cloud.token, to, texto)
    return sent?.messages?.[0]?.id || null
  },
  async enviarMidia(to, midia, estado) {
    if (!estado.cloud) throw new CanalIndisponivelError('cloud', 'nenhuma conta Cloud ativa')
    const { enviarMidiaCloudConta } = await import('@/lib/whatsapp-cloud')
    return enviarMidiaCloudConta(estado.cloud.phoneNumberId, estado.cloud.token, to, midia)
  },
}

const evolution: AdapterCanal = {
  canal: 'evolution',
  async enviarTexto(to, texto) {
    const { evolutionDiretoSendText } = await import('@/lib/evolution')
    return (await evolutionDiretoSendText(to, texto))?.key?.id || null
  },
  async enviarMidia(to, midia) {
    if (!midia.url) throw new Error('Envio por Evolution requer URL da mídia')
    const { evolutionDiretoSendMedia } = await import('@/lib/evolution')
    const sent = await evolutionDiretoSendMedia(to, {
      media: midia.url, fileName: midia.filename, caption: midia.caption,
      mediatype: classificarMidia(midia.mimetype).kind, mimetype: midia.mimetype,
    })
    return sent?.key?.id || null
  },
}

const REGISTRY: Record<Canal, AdapterCanal> = { waha, cloud, evolution }

/** Adapter do canal. Lança para canal desconhecido — sem default silencioso. */
export function adapterDe(canal: string): AdapterCanal {
  if (!ehCanal(canal)) throw new CanalIndisponivelError(String(canal), 'canal sem adapter de mensagens')
  return REGISTRY[canal]
}
