/**
 * Roteador de agente — DETERMINÍSTICO.
 *
 * Escolhe QUAL agente executa, entre os que existem de fato no escola-crm:
 *   - família MATRICULADA (SGEI) + Salomão ligado  → `salomao`
 *   - família MATRICULADA + Salomão desligado       → `humano` (sem IA comercial p/ matriculado)
 *   - família NOVA / em captação                    → `sara`
 *
 * Não há chamada de IA aqui: a rota sai de estado confiável (vínculo SGEI + flag),
 * nunca do texto da mensagem. Um 3º agente real justificaria um classificador de
 * intenção; até lá, `classificarIntencao` fica como interface desligada (ver
 * `classificador.ts` / flag `config_ia.roteador_classificador_llm`).
 *
 * Fallback seguro (prompt §8): sem destino elegível, a rota é `humano` — nunca
 * silêncio e nunca uma ação comercial indevida.
 */

export type RotaDoAgente = 'sara' | 'salomao' | 'humano'

export type MotivoDaRota =
  | 'matriculado_salomao'
  | 'matriculado_humano'
  | 'novo_sara'

export interface EntradaDoRoteador {
  /** `familias.ja_responsavel` — vínculo ativo confirmado pelo SGEI. */
  jaResponsavel: boolean
  /** `config_ia.salomao_ativo`. */
  salomaoAtivo: boolean
}

export interface DecisaoDeRota {
  rota: RotaDoAgente
  motivo: MotivoDaRota
}

export function escolherAgente(e: EntradaDoRoteador): DecisaoDeRota {
  if (e.jaResponsavel) {
    return e.salomaoAtivo
      ? { rota: 'salomao', motivo: 'matriculado_salomao' }
      : { rota: 'humano', motivo: 'matriculado_humano' }
  }
  return { rota: 'sara', motivo: 'novo_sara' }
}
