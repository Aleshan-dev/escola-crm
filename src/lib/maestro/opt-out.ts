/**
 * Detecção de opt-out / STOP (PT-BR).
 *
 * Conservadora de propósito (padrão do prompt, §13): só considera opt-out quando
 *   (a) a mensagem INTEIRA é uma palavra de cessação isolada ("parar", "sair",
 *       "stop", "cancelar", "descadastrar"); ou
 *   (b) há um verbo de cessação com um OBJETO de comunicação ("parar de receber
 *       mensagens", "me tira da lista", "não quero mais receber").
 *
 * Não bloqueia por uma palavra solta no meio de uma frase ("não consigo parar de
 * pensar na escola" NÃO é opt-out). É regra pura: nenhum efeito colateral aqui —
 * quem grava `familias.opt_out_em` é o chamador.
 */

/** Minúsculas, sem acento, só letras/números/espaço, espaços colapsados. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Mensagem inteira = uma destas palavras ⇒ opt-out. */
const PALAVRAS_ISOLADAS = new Set([
  'parar',
  'pare',
  'para',
  'sair',
  'stop',
  'cancelar',
  'cancela',
  'descadastrar',
  'remover',
])

const VERBO_CESSACAO = /\b(parar|pare|cancelar|cancela|remover|tirar|tira|descadastrar|excluir|sair)\b/
const OBJETO_COMUNICACAO = /\b(mensagens?|contato|lista|whats|whatsapp|receber|envios?|divulga\w*)\b/
const NAO_QUERO_RECEBER = /\bnao quero (mais )?(receber|ser contatad\w+)/

/** `true` quando a mensagem do cliente pede para parar de ser contatado. */
export function detectarOptOut(texto: string | null | undefined): boolean {
  if (!texto) return false
  const n = normalizar(texto)
  if (!n) return false
  if (PALAVRAS_ISOLADAS.has(n)) return true
  if (NAO_QUERO_RECEBER.test(n)) return true
  if (VERBO_CESSACAO.test(n) && OBJETO_COMUNICACAO.test(n)) return true
  return false
}
