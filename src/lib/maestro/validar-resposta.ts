/**
 * VALIDAÇÃO FINAL DO MAESTRO — portão de saída, antes de `enviarTexto`.
 *
 * Confere o TEXTO que o agente (Sara/Salomão) quer enviar contra regras de
 * política da escola (prompt §6.1/§6.4). Determinística, sem IA. Devolve os vetos
 * encontrados e o corpo já saneado (cosmético) — NÃO envia e NÃO decide sozinha o
 * que fazer: quem aplica (regenerar / transbordo / só logar) é o chamador, segundo
 * o modo (`config_ia.validacao_saida_modo`: 'off' | 'log' | 'ativo').
 *
 * Começa em modo sombra ('log'): mede o que vetaria sem bloquear, até calibrarmos
 * o falso-positivo. A lista de fatos proibidos vem de fonte oficial (injeção via
 * `ctx.fatosProibidos`); sem ela, só as checagens genéricas (promessa/condição)
 * valem. Reusa `limparTexto` da Sara como saneamento base.
 */
import { limparTexto } from '../sara'

export type CodigoDeVeto =
  | 'promessa_desconto_condicao'
  | 'valor_monetario'
  | 'fato_proibido'

export interface VetoDeSaida {
  codigo: CodigoDeVeto
  /** Trecho que disparou o veto — curto, para auditoria sem despejar a conversa. */
  trecho: string
}

export interface FatoProibido {
  /** Expressão que, se afirmada, é proibida sem fonte oficial (ex.: natação, piscina). */
  padrao: RegExp
  rotulo: string
}

export interface ContextoDeValidacao {
  /** Fatos que o agente não pode afirmar sem confirmação oficial. Default: []. */
  fatosProibidos?: FatoProibido[]
  /** A escola tem preço oficialmente cadastrado e liberado para a resposta? Default false
   * ⇒ qualquer valor monetário no texto vira veto (pode estar inventado). */
  precoOficialLiberado?: boolean
}

export interface ResultadoDeValidacao {
  ok: boolean
  vetos: VetoDeSaida[]
  corpoSaneado: string
}

// Promessa de condição comercial fora de tabela (prompt §6.1): desconto, bolsa,
// convênio, gratuidade, promoção — determinístico.
const PROMESSA_CONDICAO = /\b(descont\w+|bols\w+|conv[eê]ni\w+|gratuit\w+|promo\w+|isen\w+)\b/i
// Valor monetário explícito (R$ 1.947, "1947 reais", "mensalidade de 900").
const VALOR_MONETARIO = /(r\$\s?\d|\b\d{2,}\s?(reais|mensal\w*)\b)/i

function trechoAoRedor(texto: string, re: RegExp): string {
  const m = texto.match(re)
  if (!m || m.index === undefined) return ''
  const ini = Math.max(0, m.index - 20)
  return texto.slice(ini, m.index + m[0].length + 20).trim()
}

export function validarResposta(texto: string, ctx: ContextoDeValidacao = {}): ResultadoDeValidacao {
  const corpoSaneado = limparTexto(texto)
  const vetos: VetoDeSaida[] = []

  if (PROMESSA_CONDICAO.test(corpoSaneado)) {
    vetos.push({ codigo: 'promessa_desconto_condicao', trecho: trechoAoRedor(corpoSaneado, PROMESSA_CONDICAO) })
  }
  if (!ctx.precoOficialLiberado && VALOR_MONETARIO.test(corpoSaneado)) {
    vetos.push({ codigo: 'valor_monetario', trecho: trechoAoRedor(corpoSaneado, VALOR_MONETARIO) })
  }
  for (const fato of ctx.fatosProibidos ?? []) {
    if (fato.padrao.test(corpoSaneado)) {
      vetos.push({ codigo: 'fato_proibido', trecho: fato.rotulo })
    }
  }

  return { ok: vetos.length === 0, vetos, corpoSaneado }
}
