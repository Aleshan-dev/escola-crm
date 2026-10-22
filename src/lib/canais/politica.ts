// POLÍTICA DE CANAL POR OPERAÇÃO — função pura, sem banco.
//
// Regra de ouro (a mesma do DeskcommCRM): a conversa responde pelo canal em que
// ela acontece. Se esse canal está fora, o envio FALHA visível — nunca cai em
// outro número. Mandar pelo número errado é pior que não mandar: o lead recebe
// de um contato que não conhece e o histórico se parte.
//
// Única escolha "livre" é a campanha, que usa o canal de disparos configurado.

import { ehCanal, type Canal, type EstadoCanais, type Operacao } from './tipos'

export type Escolha = { ok: true; canal: Canal } | { ok: false; canal: Canal; motivo: string }

/**
 * Canal da conversa com a família: o carimbado na família pelo último inbound
 * (`familias.canal_whatsapp`). Sem carimbo (contato que nunca escreveu, ou o
 * número de aviso da equipe), o canal PADRÃO de atendimento: a Cloud se houver
 * conta ativa, senão o canal de disparos. Isso é configuração explícita, não
 * fallback: o padrão não muda conforme o canal da família cai ou volta.
 */
export function canalDaConversa(canalFamilia: string | null | undefined, estado: EstadoCanais): Canal {
  if (ehCanal(canalFamilia)) return canalFamilia
  return estado.cloud ? 'cloud' : estado.canalDisparo
}

/** O canal está ligado agora? */
export function disponivel(canal: Canal, estado: EstadoCanais): { ok: true } | { ok: false; motivo: string } {
  if (canal === 'waha') return estado.wahaConfigurado ? { ok: true } : { ok: false, motivo: 'WAHA não configurado' }
  if (canal === 'cloud') return estado.cloud ? { ok: true } : { ok: false, motivo: 'nenhuma conta Cloud ativa' }
  return estado.evolutionConfigurado ? { ok: true } : { ok: false, motivo: 'Evolution não configurado' }
}

/**
 * Escolhe o canal do envio. Não há fallback entre canais em nenhuma operação:
 * indisponível = `{ ok: false }` com o canal que DEVERIA ter sido usado.
 */
export function escolherCanal(
  operacao: Operacao,
  canalFamilia: string | null | undefined,
  estado: EstadoCanais,
): Escolha {
  const canal: Canal = operacao === 'campanha' ? estado.canalDisparo : canalDaConversa(canalFamilia, estado)
  const d = disponivel(canal, estado)
  return d.ok ? { ok: true, canal } : { ok: false, canal, motivo: d.motivo }
}

/** Referência da conexão no provedor, para carimbar `mensagens.canal_ref`. */
export function refDoCanal(canal: Canal, estado: EstadoCanais): string | null {
  if (canal === 'waha') return estado.wahaSessao
  if (canal === 'cloud') return estado.cloud?.phoneNumberId ?? null
  return estado.evolutionInstancia
}
