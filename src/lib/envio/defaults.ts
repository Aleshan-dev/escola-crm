// Defaults da proteção de envio (anti-ban). Ver docs/PROTECAO-ENVIO.md.
//
// Cada campo de crm.canal_protecao que estiver NULO usa o valor daqui. A tela
// /configuracoes/protecao-envio mostra o valor efetivo e de onde ele veio.

export type Canal = 'waha' | 'evolution' | 'cloud'

/** Quem originou o envio. Define qual janela vale e se o teto do dia barra. */
/**
 * `aviso_interno` = recado à EQUIPE (aviso de Caso, notificação ao gestor, alerta
 * de sistema). Sai pelo mesmo chip, então entra na contagem, mas nunca é barrado.
 */
export type OrigemEnvio = 'resposta_ia' | 'followup' | 'salomao' | 'convite' | 'manual' | 'reengajar' | 'aviso_interno'

/**
 * Canal com risco de banimento por volume. WAHA e Evolution são o WhatsApp
 * não-oficial (chip): ritmo, aquecimento e teto valem. A Cloud oficial não é
 * banida por volume, e sim por qualidade/templates — lá o motor só aplica a
 * janela de cortesia e o opt-out.
 */
export const BAN_RISK: Record<Canal, boolean> = { waha: true, evolution: true, cloud: false }

/**
 * Origens PROATIVAS: a empresa fala primeiro. São as únicas barradas pelo teto do
 * dia/aquecimento e as que usam a janela de DISPARO. Resposta da IA (o cliente
 * acabou de escrever) e envio manual entram na contagem, mas não são barrados.
 */
export const ORIGEM_PROATIVA: Record<OrigemEnvio, boolean> = {
  resposta_ia: false,
  manual: false,
  aviso_interno: false,
  followup: true,
  salomao: true,
  convite: true,
  reengajar: true,
}

export interface ConfigCanal {
  numeroDesde: string | null // 'YYYY-MM-DD'
  pularAquecimento: boolean
  janelaResposta: [number, number] // [ini, fim) em horas locais; [0,24] = sempre
  janelaDisparo: [number, number]
  domingoDisparo: boolean
  intervaloMinMs: number
  jitterMaxMs: number
  tetoDiario: number | null
  fuso: string
}

// Janela de disparo = o horário comercial que já valia (followup-regras.ts, 8h–20h Acre).
export const DEFAULTS: ConfigCanal = {
  numeroDesde: null,
  pularAquecimento: false,
  janelaResposta: [0, 24],
  janelaDisparo: [8, 20],
  domingoDisparo: true,
  intervaloMinMs: 1200,
  jitterMaxMs: 800,
  tetoDiario: null,
  fuso: 'America/Rio_Branco',
}

/**
 * Degraus de aquecimento pela idade do NÚMERO (dias desde `numero_desde`).
 * Sem data declarada = idade 0 = degrau mais conservador.
 */
export const AQUECIMENTO: { ateDia: number; teto: number }[] = [
  { ateDia: 3, teto: 20 },
  { ateDia: 7, teto: 50 },
  { ateDia: 14, teto: 100 },
  { ateDia: 30, teto: 200 },
]

/** Gate de texto repetido: últimas N saídas do canal, Jaccard ≥ limiar, veta a partir de K ocorrências. */
export const REPETICAO = {
  janela: 20,
  limiar: 0.8,
  minOcorrencias: 2,
  minCaracteres: 16, // até 15 caracteres ("ok", "combinado") é isento
  // Cobrança e boleto repetem por natureza: mesmo texto-modelo para cada família.
  isentos: [/\bpix\b/i, /\bboleto\b/i, /\bcobran[çc]a\b/i, /https?:\/\/\S*(pag|checkout|pay)/i],
}

/**
 * Origens sujeitas ao gate de repetição. Campanhas (comunicado/boleto do Salomão,
 * convite de matrícula) mandam o MESMO texto-modelo a muitas famílias por
 * desenho — vetar a 3ª cópia quebraria o disparo. Lá o freio é o ritmo + teto.
 * Manual também fica de fora (a pessoa decide).
 */
export const ORIGEM_CHECA_REPETICAO: Record<OrigemEnvio, boolean> = {
  resposta_ia: true,
  followup: true,
  reengajar: true,
  salomao: false,
  convite: false,
  manual: false,
  aviso_interno: false,
}

/** Espera máxima que um envio aceita aguardar o intervalo antes de virar `adiado`. */
export const ESPERA_MAX_MS = 15_000

export type ModoProtecao = 'off' | 'log' | 'ativo'

/** `PROTECAO_ENVIO_MODO`: off desliga; log (default) só registra o que barraria; ativo barra. */
export function modoProtecao(): ModoProtecao {
  const v = (process.env.PROTECAO_ENVIO_MODO || 'log').toLowerCase()
  return v === 'off' || v === 'ativo' ? v : 'log'
}
