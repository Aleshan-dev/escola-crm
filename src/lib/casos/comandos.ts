/**
 * Comandos de Caso pelo WhatsApp da equipe (número de aviso). Formato:
 *
 *   #C12 ok <resposta para a família>
 *   #C12 pedir <informação que falta>
 *   #C12 humano [observação]
 *
 * Puro: só interpreta o texto. Quem executa é `executarComando` (servico.ts),
 * que chama as MESMAS ações da tela.
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
