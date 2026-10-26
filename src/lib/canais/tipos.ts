// Tipos do roteamento de canais de saída. Ver docs/CANAIS-DE-SAIDA.md.

import type { Canal } from '@/lib/envio/defaults'

export type { Canal }

export const CANAIS: readonly Canal[] = ['waha', 'cloud', 'evolution']

/**
 * O QUE está sendo enviado — decide QUAL canal a política deixa usar.
 *  - resposta / followup / manual: conversa com a família → só o canal da conversa.
 *  - campanha: disparo em massa (Salomão, convites) → o canal de disparos.
 *  - aviso_interno: recado à equipe (Casos, gestor, alertas) → o canal do número de aviso.
 */
export type Operacao = 'resposta' | 'followup' | 'manual' | 'campanha' | 'aviso_interno'

/** Foto do que está ligado agora. Lida uma vez por envio (src/lib/canais/estado.ts). */
export interface EstadoCanais {
  /** Conta Cloud ativa no banco (a do phoneId pedido, ou a mais recente). */
  cloud: { phoneNumberId: string; token: string } | null
  wahaConfigurado: boolean
  /** Evolution configurado no env (independe da flag WHATSAPP_PROVIDER). */
  evolutionConfigurado: boolean
  /** Canal não-oficial dos disparos (env WHATSAPP_PROVIDER). */
  canalDisparo: 'waha' | 'evolution'
  /** Sessão WAHA / instância Evolution, para carimbar canal_ref. */
  wahaSessao: string | null
  evolutionInstancia: string | null
}

export function ehCanal(v: unknown): v is Canal {
  return typeof v === 'string' && (CANAIS as readonly string[]).includes(v)
}

/** O canal da conversa está desligado/desconfigurado. NADA saiu; não troca de número. */
export class CanalIndisponivelError extends Error {
  constructor(public readonly canal: string, public readonly motivo: string) {
    super(`canal ${canal} indisponível: ${motivo}`)
    this.name = 'CanalIndisponivelError'
  }
}

/** O canal relido na hora do envio não é o que o chamador avaliou (portão/janela). NADA saiu. */
export class CanalDivergenteError extends Error {
  constructor(public readonly esperado: string, public readonly atual: string) {
    super(`canal mudou durante o envio: esperado ${esperado}, atual ${atual}`)
    this.name = 'CanalDivergenteError'
  }
}
