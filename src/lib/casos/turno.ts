/**
 * Efeitos de Caso de um turno de atendimento (Sara ou Salomão), depois do envio:
 *  - `atualizar_caso` → a família respondeu o que a equipe pediu;
 *  - `abrir_caso`     → novo Caso para a equipe;
 *  - guarda de promessa: prometeu retorno sem Caso → em 'ativo' abre Caso mínimo
 *    (origem 'guarda_promessa'), em 'log' só registra.
 * Transbordo no mesmo turno vence: o lead já vai para humano, não abre Caso.
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import { validarAbertura, type AgenteCaso } from './regras'
import { detectaPromessaHumana, modoGuarda } from './guarda-promessa'
import { abrirCaso, atualizarPelaFamilia, casoAbertoDoLead, lerConfigCasos } from './servico'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export async function aplicarCasosDoTurno(
  supabase: SupaAdmin,
  args: {
    leadId: string
    agente: AgenteCaso
    abrirCaso: unknown
    atualizarCaso: { informacao: string } | null
    resposta: string
    transbordo: boolean
    conteudoIn: string
  }
): Promise<void> {
  const cfg = await lerConfigCasos(supabase)
  if (!cfg.ativo) return

  if (args.atualizarCaso) {
    await atualizarPelaFamilia(supabase, { leadId: args.leadId, agente: args.agente, informacao: args.atualizarCaso.informacao })
  }
  if (args.transbordo) return

  const pedido = validarAbertura(args.abrirCaso)
  if (pedido) {
    await abrirCaso(supabase, { leadId: args.leadId, agente: args.agente, pedido, origem: 'agente' })
    return
  }

  const modo = modoGuarda(cfg.guardaPromessa)
  if (modo === 'off') return
  const promessa = detectaPromessaHumana(args.resposta)
  if (!promessa) return
  if (await casoAbertoDoLead(supabase, args.leadId)) return

  if (modo === 'log') {
    console.warn(`[casos/guarda modo=log] ${args.agente} prometeu sem Caso (lead ${args.leadId}): "${promessa}"`)
    return
  }
  await abrirCaso(supabase, {
    leadId: args.leadId,
    agente: args.agente,
    origem: 'guarda_promessa',
    pedido: {
      titulo: 'Retorno prometido à família',
      resumo: `A família escreveu: "${args.conteudoIn.slice(0, 600)}"\nA IA respondeu: "${args.resposta.slice(0, 600)}"`,
      motivo: 'A IA prometeu verificar/retornar sem abrir um Caso; aberto automaticamente para a promessa não ficar sem dono.',
      tipo: 'outro',
    },
  })
}
