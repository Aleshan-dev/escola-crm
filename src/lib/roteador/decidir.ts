/**
 * Roteador de agente — DETERMINÍSTICO.
 *
 * Escolhe QUAL agente executa, entre os que existem de fato no escola-crm:
 *   - família MATRICULADA (SGEI) + Salomão ligado  → `salomao`
 *   - família MATRICULADA + Salomão desligado       → `humano` (sem IA comercial p/ matriculado)
 *   - família NOVA / em captação                    → `sara`
 *
 * Não há chamada de IA aqui: a rota sai de estado confiável (vínculo SGEI + flag),
 * nunca do texto da mensagem. Esta é a GUARDA. A camada de intenção opcional
 * (`classificador.ts` + `resolver.ts`, ligada em `crm.roteador_config`) roda por
 * cima e só pode manter este agente ou encaminhar para humano.
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
