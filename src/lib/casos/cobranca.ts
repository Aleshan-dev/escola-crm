/**
 * Casos parados — roda no heartbeat (crons dedicados já morreram calados, ADR-008).
 *  - aguardando_equipe há 24h sem atualização: reaviso por WhatsApp, até 3 vezes.
 *  - aguardando_familia há 48h: volta para a equipe (evento familia_sem_resposta)
 *    e avisa. Não manda nada para a família.
 * Também refaz retornos da IA cujo after() morreu (retorno.ts).
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import { avisarEquipe, lerConfigCasos, transicionar, type Caso } from './servico'
import { reprocessarRetornosPendentes } from './retorno'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export const HORAS_COBRANCA_EQUIPE = 24
export const MAX_COBRANCAS = 3
export const HORAS_SEM_RESPOSTA_FAMILIA = 48

export async function cobrarCasosParados(supabase: SupaAdmin): Promise<{ cobrados: number; devolvidos: number; retornos: number }> {
  const cfg = await lerConfigCasos(supabase)
  if (!cfg.ativo) return { cobrados: 0, devolvidos: 0, retornos: 0 }

  const retornos = await reprocessarRetornosPendentes(supabase)

  let cobrados = 0
  const corteEquipe = new Date(Date.now() - HORAS_COBRANCA_EQUIPE * 3_600_000).toISOString()
  const { data: parados } = await supabase
    .from('casos')
    .select('*')
    .eq('estado', 'aguardando_equipe')
    .lt('atualizado_em', corteEquipe)
    .lt('cobrancas', MAX_COBRANCAS)
    .limit(20)
  for (const c of (parados ?? []) as Caso[]) {
    const n = c.cobrancas + 1
    // Update condicional: só cobra quem ainda está como lido (sem corrida dupla).
    const { data: up } = await supabase
      .from('casos')
      .update({ cobrancas: n, atualizado_em: new Date().toISOString() })
      .eq('id', c.id)
      .eq('estado', 'aguardando_equipe')
      .eq('cobrancas', c.cobrancas)
      .select('id')
    if (!up || up.length === 0) continue
    await supabase.from('caso_eventos').insert({ caso_id: c.id, tipo: 'cobranca', ator: 'sistema', detalhe: { n } })
    // Chave pelo atualizado_em lido: o contador zera quando o Caso volta para a
    // equipe, então "cobranca:1" se repetiria entre ciclos.
    if ((await avisarEquipe(supabase, c, 'cobranca', `cobranca:${c.atualizado_em}`)) === 'enviado') cobrados++
  }

  let devolvidos = 0
  const corteFamilia = new Date(Date.now() - HORAS_SEM_RESPOSTA_FAMILIA * 3_600_000).toISOString()
  const { data: semResposta } = await supabase
    .from('casos')
    .select('id')
    .eq('estado', 'aguardando_familia')
    .lt('atualizado_em', corteFamilia)
    .limit(20)
  for (const c of semResposta ?? []) {
    const novo = await transicionar(supabase, {
      casoId: c.id, de: ['aguardando_familia'], para: 'aguardando_equipe',
      evento: 'familia_sem_resposta', ator: 'sistema',
    })
    if (!novo) continue
    devolvidos++
    await avisarEquipe(supabase, novo, 'familia_sem_resposta', `sem_resposta:${novo.atualizado_em}`)
  }

  return { cobrados, devolvidos, retornos }
}
