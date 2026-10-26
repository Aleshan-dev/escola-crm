// CANAL DE DISPAROS NÃO-OFICIAL — ROTEADOR DE PROVEDOR.
//
// Este módulo mantém os nomes históricos (`evolutionSendText`, `evolutionSendMedia`,
// `evolutionConnectionState`, `evolutionConfigurado`) como a INTERFACE do canal
// não-oficial. Por baixo, ele DESPACHA para o Evolution ou para o WAHA conforme a
// env `WHATSAPP_PROVIDER`:
//
//   WHATSAPP_PROVIDER=evolution  (default) → implementação Evolution abaixo
//   WHATSAPP_PROVIDER=waha                  → src/lib/waha.ts
//
// POR QUE ASSIM: a troca de motor de disparos (Salomão + convites) fica atrás de
// UMA env var, sem tocar em nenhum chamador, e o rollback é reverter a env — sem
// redeploy de código. Enquanto a flag for 'evolution', o comportamento é
// idêntico ao de antes desta mudança.
//
// (O nome "evolution" virou o rótulo do canal; um rename futuro dos call sites
// pode neutralizá-lo, mas isso é faxina, não pré-requisito da troca.)

import {
  wahaSendText,
  wahaSendMedia,
  wahaConnectionState,
  wahaConfigurado,
} from '@/lib/waha'

const URL = process.env.EVOLUTION_API_URL!
const KEY = process.env.EVOLUTION_API_KEY!
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME!

// Provedor ativo do canal não-oficial. Default: evolution (comportamento legado).
function provider(): 'evolution' | 'waha' {
  return (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase() === 'waha' ? 'waha' : 'evolution'
}

/** Canal físico por onde `evolutionSendText`/`Media` saem agora (rótulo do portão de envio). */
export function canalNaoOficial(): 'evolution' | 'waha' {
  return provider()
}

// ============================================================================
// Implementação EVOLUTION (legado). Mantida intacta — é o rollback da flag.
// ============================================================================

async function evoSendText(numero: string, texto: string) {
  const r = await fetch(`${URL}/message/sendText/${encodeURIComponent(INSTANCE)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({
      number: numero,
      text: texto,
    }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Evolution send falhou (${r.status}): ${t}`)
  }
  return r.json()
}

// Envia uma mídia (documento/imagem) pela mesma instância Evolution.
// `media` é uma URL pública — o Evolution baixa e envia. Usado para os boletos
// do Salomão (PDF). Lança em erro para o chamador reportar/registrar.
async function evoSendMedia(
  numero: string,
  opts: { media: string; fileName: string; caption?: string; mediatype?: string; mimetype?: string }
) {
  const r = await fetch(`${URL}/message/sendMedia/${encodeURIComponent(INSTANCE)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({
      number: numero,
      mediatype: opts.mediatype || 'document',
      mimetype: opts.mimetype || 'application/pdf',
      media: opts.media,
      fileName: opts.fileName,
      caption: opts.caption || '',
    }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Evolution sendMedia falhou (${r.status}): ${t.slice(0, 300)}`)
  }
  return r.json()
}

// Estado da conexão da instância Evolution. Nunca lança: se a API está fora,
// isso JÁ é o diagnóstico.
async function evoConnectionState(): Promise<{ ok: boolean; payload: unknown; erro?: string }> {
  try {
    const r = await fetch(`${URL}/instance/connectionState/${encodeURIComponent(INSTANCE)}`, {
      headers: { apikey: KEY },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      return { ok: false, payload: null, erro: `connectionState HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }
    }
    return { ok: true, payload: await r.json() }
  } catch (e) {
    return { ok: false, payload: null, erro: e instanceof Error ? e.message : 'falha de rede' }
  }
}

function evoConfigurado(): boolean {
  return !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE_NAME)
}

// ============================================================================
// INTERFACE PÚBLICA (roteada por WHATSAPP_PROVIDER). Assinaturas e formato de
// retorno idênticos ao Evolution — os chamadores leem `sent?.key?.id`.
// ============================================================================

export async function evolutionSendText(numero: string, texto: string) {
  return provider() === 'waha' ? wahaSendText(numero, texto) : evoSendText(numero, texto)
}

export async function evolutionSendMedia(
  numero: string,
  opts: { media: string; fileName: string; caption?: string; mediatype?: string; mimetype?: string }
) {
  return provider() === 'waha' ? wahaSendMedia(numero, opts) : evoSendMedia(numero, opts)
}

// ── Transporte Evolution DIRETO (ignora a flag) ───────────────────────────────
// Para o roteamento de canais (src/lib/canais): uma conversa que entrou pelo
// Evolution responde pelo Evolution, mesmo com a flag de disparos em 'waha'.
export const evolutionDiretoSendText = evoSendText
export const evolutionDiretoSendMedia = evoSendMedia
export const evolutionDiretoConfigurado = evoConfigurado

export async function evolutionConnectionState(): Promise<{ ok: boolean; payload: unknown; erro?: string }> {
  return provider() === 'waha' ? wahaConnectionState() : evoConnectionState()
}

// true se o canal não-oficial ATIVO está configurado (Evolution ou WAHA).
// Async porque a config do WAHA pode vir do banco (crm.integracao_waha).
export async function evolutionConfigurado(): Promise<boolean> {
  return provider() === 'waha' ? wahaConfigurado() : evoConfigurado()
}

// Limpa número do formato WhatsApp ('5589xxxx@s.whatsapp.net' ou '...@c.us' →
// '5589xxxx'). Serve para os dois provedores (ambos separam no '@').
export function cleanWhatsappJid(jid: string): string {
  return jid.split('@')[0].split(':')[0]
}
