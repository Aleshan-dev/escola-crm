// Atribuição de origem do lead — distingue quem chegou por ANÚNCIO PAGO
// (Click-to-WhatsApp do Instagram/Meta) de quem chegou orgânico.
//
// POR QUE A FRASE, E NÃO SÓ O REFERRAL: o canal de atendimento vivo é o WAHA
// (WhatsApp não-oficial). O objeto "referral" do CTWA só é garantido na Cloud
// API oficial; pelo WAHA ele varia por engine (GOWS/WEBJS) e muitas vezes não
// vem. A identificação CONFIÁVEL é pela mensagem pré-preenchida do anúncio: ao
// clicar no anúncio, o WhatsApp já abre a conversa com um texto que o lead envia
// como 1ª mensagem. Casando esse texto, sabemos que o lead veio do anúncio —
// independente do engine. Quando o referral VIER, usamos como bônus (campanha +
// auditoria), mas ele nunca é obrigatório.
//
// A atribuição é FIRST-TOUCH: processarMensagemRecebida só grava canal/campanha/
// referral no INSERT da família (1º contato). Mensagens seguintes não sobrescrevem.

import { createServerAdminClient } from '@/lib/supabase-server'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export interface ConfigAnuncio {
  /** Cada item: a frase-gatilho normalizada + a campanha daquela linha (ou null). */
  frases: { texto: string; campanha: string | null }[]
  /** Campanha padrão quando a linha não define a própria. */
  campanhaPadrao: string | null
}

export interface OrigemLead {
  canal: 'meta-ads' | 'organico'
  campanha: string | null
  /** Payload para auditoria (referral nativo do CTWA, ou a marca da frase casada). */
  referral: unknown | null
}

// minúsculas, sem acentos, sem pontuação/emoji, espaços colapsados. Deixa só
// letras/números/espaço para o casamento ser estável entre o que a Meta manda e
// o que foi configurado (acento, emoji e pontuação variam).
export function normalizarFrase(texto: string): string {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Frases curtas demais casariam em qualquer conversa ("oi", "ola"). Exige um
// mínimo de sinal para marcar meta-ads por frase.
const MIN_FRASE = 12

/** Lê as frases-gatilho e a campanha padrão de config_ia (id=1). */
export async function lerConfigAnuncio(supabase: SupaAdmin): Promise<ConfigAnuncio> {
  const { data } = await supabase
    .from('config_ia')
    .select('meta_ads_frases, meta_ads_campanha')
    .eq('id', 1)
    .maybeSingle()
  const campanhaPadrao = (data?.meta_ads_campanha as string | null)?.trim() || null
  const bruto = (data?.meta_ads_frases as string | null) || ''
  const frases = bruto
    .split('\n')
    .map((linha) => linha.trim())
    .filter(Boolean)
    .map((linha) => {
      // "frase => campanha" distingue criativos; sem "=>" usa a campanha padrão.
      const [fraseRaw, campRaw] = linha.split('=>')
      return {
        texto: normalizarFrase(fraseRaw),
        campanha: campRaw?.trim() || null,
      }
    })
    .filter((f) => f.texto.length >= MIN_FRASE)
  return { frases, campanhaPadrao }
}

// Procura o objeto externalAdReply (referral do CTWA) no payload do WAHA, por
// vários caminhos possíveis conforme o engine. Defensivo: nunca lança.
export function extrairReferralWaha(p: unknown): Record<string, unknown> | null {
  const obj = p as Record<string, any> | null | undefined // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!obj) return null
  const candidatos = [
    obj?._data?.message?.extendedTextMessage?.contextInfo?.externalAdReply,
    obj?._data?.Message?.extendedTextMessage?.contextInfo?.externalAdReply,
    obj?._data?.message?.contextInfo?.externalAdReply,
    obj?._data?.contextInfo?.externalAdReply,
    obj?.contextInfo?.externalAdReply,
    obj?.externalAdReply,
  ]
  for (const c of candidatos) {
    if (c && typeof c === 'object') return c as Record<string, unknown>
  }
  return null
}

/**
 * Decide a origem de UM contato a partir do texto do 1º recado, de um referral
 * (quando o canal o entrega) e da config de anúncio. Sem config e sem referral,
 * devolve 'organico' — o comportamento de hoje, nada muda.
 */
export function detectarOrigem(args: {
  texto: string
  referral?: unknown | null
  cfg: ConfigAnuncio
}): OrigemLead {
  const { texto, referral, cfg } = args

  // 1) Referral nativo do CTWA (quando vem): sinal mais forte.
  const ref = (referral && typeof referral === 'object' ? (referral as Record<string, unknown>) : null)
  if (ref) {
    const titulo =
      (ref.title as string) || (ref.sourceId as string) || (ref.body as string) || null
    return { canal: 'meta-ads', campanha: titulo || cfg.campanhaPadrao, referral: ref }
  }

  // 2) Frase-gatilho do anúncio no 1º recado.
  const alvo = normalizarFrase(texto)
  if (alvo.length >= MIN_FRASE) {
    for (const f of cfg.frases) {
      if (alvo.includes(f.texto)) {
        return {
          canal: 'meta-ads',
          campanha: f.campanha || cfg.campanhaPadrao,
          referral: { via: 'frase-anuncio', frase: f.texto },
        }
      }
    }
  }

  return { canal: 'organico', campanha: null, referral: null }
}
