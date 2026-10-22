/**
 * Respostas de Caso pelo WhatsApp da equipe (número de aviso). Três formas:
 *
 *   1. Com código:     #C12 ok <resposta> | #C12 pedir <pergunta> | #C12 humano
 *   2. Citando o aviso (responder no WhatsApp): o texto livre CONCLUI o Caso com
 *      aquele texto; "pedir …" / "humano" no começo escolhem a outra ação.
 *   3. Sem código e sem citação: só com o verbo no começo ("ok …", "pedir …",
 *      "humano") e só se houver UM Caso esperando a equipe. Texto sem verbo segue
 *      o fluxo normal — o número de aviso costuma ser o do gestor, que também
 *      conversa com a escola por outros motivos.
 *
 * Puro: só interpreta. Quem executa é `executarRespostaEquipe` (servico.ts), que
 * chama as MESMAS ações da tela.
 */
import type { AcaoEquipe } from './regras'

export interface ComandoCaso {
  numero: number
  acao: AcaoEquipe
  nota: string
}

const VERBOS: Record<string, AcaoEquipe> = {
  ok: 'concluir',
  concluir: 'concluir',
  concluido: 'concluir',
  'concluído': 'concluir',
  resolvido: 'concluir',
  pedir: 'pedir_info',
  perguntar: 'pedir_info',
  info: 'pedir_info',
  humano: 'escalar',
  escalar: 'escalar',
}

/** Parece comando (#C<n> no início)? Usado para decidir se a mensagem sai do fluxo normal. */
export function pareceComando(texto: string): boolean {
  return /^\s*#c\d+\b/i.test(texto || '')
}

/** Interpreta o comando. Formato reconhecível mas inválido devolve { erro } com a ajuda. */
export function interpretarComando(texto: string): ComandoCaso | { erro: string } | null {
  const m = /^\s*#c(\d+)\s*([^\s]*)\s*([\s\S]*)$/i.exec(texto || '')
  if (!m) return null
  const numero = Number(m[1])
  const verbo = m[2].toLowerCase().replace(/[:,.!]+$/, '')
  const acao = VERBOS[verbo]
  if (!acao) return { erro: AJUDA(numero) }
  return { numero, acao, nota: m[3].trim() }
}

export const AJUDA = (n: number | string) =>
  `Não entendi o comando. Use:\n#C${n} ok <resposta para a família>\n#C${n} pedir <o que perguntar à família>\n#C${n} humano`

/** Separa um verbo de ação no começo do texto ("ok, pode vir" → concluir + "pode vir"). */
function verboNoInicio(texto: string): { acao: AcaoEquipe; resto: string } | null {
  const m = /^\s*([^\s:,.!]+)[:,.!]*\s*([\s\S]*)$/.exec(texto || '')
  if (!m) return null
  const acao = VERBOS[m[1].toLowerCase()]
  return acao ? { acao, resto: m[2].trim() } : null
}

/**
 * Id curto (stanza) de uma mensagem do WhatsApp. O WAHA grava o id serializado
 * ("true_5568…@c.us_3EB0ABC") mas cita só o curto ("3EB0ABC"); Cloud e Evolution
 * usam o mesmo id nos dois lados.
 */
export function stanzaDe(wid: string | null | undefined): string {
  const w = (wid || '').trim()
  const m = /^(?:true|false)_[^_]+_(.+)$/.exec(w)
  return m ? m[1] : w
}

/**
 * Interpreta uma mensagem do número de aviso.
 * - `numeroCitado`: Caso do aviso que a mensagem cita (null = não cita um aviso).
 * - `esperando`: números dos Casos em "aguardando equipe".
 * null = não é resposta de Caso (segue o fluxo normal).
 */
export function interpretarRespostaEquipe(
  texto: string,
  alvo: { numeroCitado: number | null; esperando: number[] }
): ComandoCaso | { erro: string } | null {
  if (pareceComando(texto)) return interpretarComando(texto)

  const verbo = verboNoInicio(texto)
  if (alvo.numeroCitado != null) {
    return verbo
      ? { numero: alvo.numeroCitado, acao: verbo.acao, nota: verbo.resto }
      : { numero: alvo.numeroCitado, acao: 'concluir', nota: (texto || '').trim() }
  }

  if (!verbo) return null
  if (alvo.esperando.length === 1) return { numero: alvo.esperando[0], acao: verbo.acao, nota: verbo.resto }
  if (alvo.esperando.length === 0) return { erro: 'Não há nenhum Caso esperando resposta da equipe agora.' }
  return {
    erro: `Há ${alvo.esperando.length} Casos esperando resposta (${alvo.esperando.map((n) => `#C${n}`).join(', ')}). ` +
      'Responda citando o aviso do Caso no WhatsApp, ou use o código: #C12 ok <resposta>.',
  }
}
