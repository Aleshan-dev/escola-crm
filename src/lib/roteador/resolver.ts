/**
 * Resolução do turno: guarda determinística + camada de intenção.
 *
 * Precedência (do mais forte ao mais fraco):
 *   1. Maestro (opt-out, humano forçado, IA pausada) e a GUARDA do vínculo SGEI
 *      (matriculado → Salomão, novo → Sara) — `decidirPolitica`. Regra dura.
 *   2. Classificador (se ligado e a guarda permitir resposta): só pode MANTER o
 *      agente da guarda ou ENCAMINHAR PARA HUMANO. Intenção que aponte outro agente
 *      de IA (ex.: Sara para família matriculada) é vetada pela guarda.
 *   3. Falha, `none` ou confiança abaixo do mínimo → fica a decisão da guarda.
 *
 * "Sticky" aqui é estrutural: o agente vem do estado da família (SGEI), não da
 * frase, então uma mensagem ambígua nunca troca quem atende. E o encaminhamento
 * para humano pausa a IA do lead até alguém devolver (ADR-005).
 */
import type { DecisaoDaPolitica } from '@/lib/maestro/politica'
import type { Classificacao, Intencao } from './classificador'

export type ResultadoDoRoteador =
  | 'guarda'          // classificador desligado/não aplicável: vale a guarda
  | 'classificado'    // intenção confirma o agente da guarda
  | 'escalado_humano' // intenção de humano com confiança suficiente
  | 'vetado_guarda'   // intenção apontou outro agente de IA — ignorada
  | 'sem_match'       // modelo respondeu none
  | 'baixa_confianca'
  | 'falha'

export interface RotaResolvida {
  rota: DecisaoDaPolitica['rota']
  permite: boolean
  resultado: ResultadoDoRoteador
  intencao: string | null
  confianca: number | null
}

/** Função pura: aplica a classificação sobre a decisão da guarda. */
export function resolverRota(
  guarda: DecisaoDaPolitica,
  classificacao: Classificacao | null,
  intencoes: Intencao[],
  minConfianca: number
): RotaResolvida {
  const base = { rota: guarda.rota, permite: guarda.permite, intencao: null, confianca: null }
  if (!guarda.permite || classificacao === null) return { ...base, resultado: 'guarda' }
  if (!classificacao.ok) return { ...base, resultado: 'falha' }

  const { intencao, confianca } = classificacao
  const comIntencao = { ...base, intencao, confianca }
  if (intencao === null) return { ...comIntencao, resultado: 'sem_match' }
  if (confianca < minConfianca) return { ...comIntencao, resultado: 'baixa_confianca' }

  const alvo = intencoes.find((i) => i.nome === intencao)?.agente
  if (alvo === 'humano') return { ...comIntencao, rota: 'humano', permite: false, resultado: 'escalado_humano' }
  if (alvo === guarda.rota) return { ...comIntencao, resultado: 'classificado' }
  return { ...comIntencao, resultado: 'vetado_guarda' }
}
