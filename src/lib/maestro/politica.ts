/**
 * MAESTRO GUARDIÃO — supervisor de política (determinístico).
 *
 * Decide, ANTES de qualquer agente, se a IA pode responder automaticamente e por
 * qual rota. É função PURA: recebe o estado já lido do banco e devolve a decisão —
 * quem lê o banco e aplica efeitos é o chamador (`processarMensagemRecebida`).
 *
 * Ordem de precedência (prompt §5.2), do mais forte ao mais fraco:
 *   1. opt-out / STOP            → humano, não responde (veto do cliente)
 *   2. atendimento humano forçado → humano, não responde (`precisa_atendimento_humano`)
 *   3. IA pausada                → humano, não responde (`ia_ativa=false`, inclui ADR-005)
 *   4. escolha do agente         → delega ao roteador determinístico (matriculado/novo)
 *
 * O Maestro NUNCA transforma incerteza em autorização: qualquer gate negativo
 * resulta em `permite:false` e rota `humano`. A escolha entre Sara e Salomão só
 * acontece depois que todos os vetos passam.
 */
import { escolherAgente, type RotaDoAgente, type MotivoDaRota } from '../roteador/decidir'

export type MotivoDaPolitica = 'opt_out' | 'force_human' | 'ia_pausada' | MotivoDaRota

export interface EstadoDePolitica {
  /** Cliente pediu para parar de ser contatado (`familias.opt_out_em` ou detecção na mensagem). */
  optOut: boolean
  /** `leads.precisa_atendimento_humano`. */
  precisaAtendimentoHumano: boolean
  /** `leads.ia_ativa`. */
  iaAtiva: boolean
  /** `familias.ja_responsavel` — matriculado (SGEI). */
  jaResponsavel: boolean
  /** `config_ia.salomao_ativo`. */
  salomaoAtivo: boolean
}

export interface DecisaoDaPolitica {
  /** A IA pode responder automaticamente agora? */
  permite: boolean
  /** Para onde vai o turno. `humano` = sem resposta automática. */
  rota: RotaDoAgente
  motivo: MotivoDaPolitica
}

export function decidirPolitica(e: EstadoDePolitica): DecisaoDaPolitica {
  if (e.optOut) return { permite: false, rota: 'humano', motivo: 'opt_out' }
  if (e.precisaAtendimentoHumano) return { permite: false, rota: 'humano', motivo: 'force_human' }
  if (!e.iaAtiva) return { permite: false, rota: 'humano', motivo: 'ia_pausada' }

  const { rota, motivo } = escolherAgente({ jaResponsavel: e.jaResponsavel, salomaoAtivo: e.salomaoAtivo })
  return { permite: rota !== 'humano', rota, motivo }
}
