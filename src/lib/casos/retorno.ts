/**
 * Turno de RETORNO: depois que a equipe concluiu ou pediu informação, a IA dona do
 * Caso volta à conversa para comunicar à família. Reusa o runtime do agente
 * (gerarRespostaSara / gerarRespostaSalomaoLLM) com uma instrução interna no fim
 * do histórico, e envia pela mesma cadeia do atendimento (portão anti-ban).
 *
 * Disparado em after() pela rota/comando; o heartbeat refaz o que ficou com
 * retorno_pendente_em antigo. A reivindicação (update condicional que zera a
 * marca) garante que só uma execução envia.
 */
import { createServerAdminClient } from '@/lib/supabase-server'
import { gerarRespostaSara } from '@/lib/sara'
import { gerarRespostaSalomaoLLM } from '@/lib/salomao'
import { dividirEmBaloes } from '@/lib/baloes'
import { sleep } from '@/lib/pacing'
import { transporteDaConversa } from '@/lib/canais/enviar'
import { protegerEnviarTexto } from '@/lib/envio/portao'
import { instrucaoRetorno } from './regras'
import type { Caso } from './servico'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

const MAX_FALHAS = 3

export async function executarRetornoCaso(casoId: string, supabase: SupaAdmin = createServerAdminClient()): Promise<string> {
  const { data } = await supabase.from('casos').select('*').eq('id', casoId).maybeSingle()
  const caso = data as Caso | null
  if (!caso?.retorno_pendente_em) return 'sem_retorno_pendente'

  const acao = caso.estado === 'concluido' ? 'concluir' : caso.estado === 'aguardando_familia' ? 'pedir_info' : null

  // Reivindica: só quem zerar a marca exatamente como leu segue adiante.
  const { data: claim } = await supabase
    .from('casos')
    .update({ retorno_pendente_em: null })
    .eq('id', caso.id)
    .eq('retorno_pendente_em', caso.retorno_pendente_em)
    .select('id')
  if (!claim || claim.length === 0) return 'outra_execucao'
  if (!acao) return 'estado_sem_retorno'

  const registrar = (tipo: string, detalhe: Record<string, unknown> = {}) =>
    supabase.from('caso_eventos').insert({ caso_id: caso.id, tipo, ator: caso.agente, detalhe })

  const { data: lead } = await supabase
    .from('leads')
    .select('id, ia_ativa, precisa_atendimento_humano, familia:familias(id, telefone, whatsapp_phone_number_id, opt_out_em)')
    .eq('id', caso.lead_id)
    .maybeSingle()
  const familia = (Array.isArray(lead?.familia) ? lead?.familia[0] : lead?.familia) as
    | { id: string; telefone: string; whatsapp_phone_number_id: string | null; opt_out_em: string | null }
    | null
  if (!lead || !familia?.telefone) {
    await registrar('retorno_pulado', { motivo: 'lead_sem_telefone' })
    return 'sem_telefone'
  }
  // IA pausada (equipe assumiu, transbordo, opt-out): a IA não fala. A decisão fica
  // registrada para quem estiver atendendo.
  if (!lead.ia_ativa || lead.precisa_atendimento_humano || familia.opt_out_em) {
    await registrarRetornoPulado(supabase, caso, 'ia_pausada')
    return 'ia_pausada'
  }

  try {
    const turnoFinal = instrucaoRetorno(acao, caso.titulo, caso.nota_equipe ?? '')
    let texto: string
    if (caso.agente === 'salomao') {
      const { data: l } = await supabase.from('leads').select('salomao_cpf_tentativas').eq('id', caso.lead_id).maybeSingle()
      const r = await gerarRespostaSalomaoLLM(supabase, caso.lead_id, undefined, l?.salomao_cpf_tentativas || 0, null, { turnoFinal })
      texto = r.resposta
    } else {
      const r = await gerarRespostaSara(caso.lead_id, undefined, undefined, undefined, null, { turnoFinal })
      texto = r.resposta
    }

    const conversa = await transporteDaConversa({
      telefone: familia.telefone, familiaId: familia.id, leadId: caso.lead_id, phoneId: familia.whatsapp_phone_number_id,
    })
    const enviar = protegerEnviarTexto(
      { origem: 'resposta_ia', canal: conversa.canal, leadId: caso.lead_id, familiaId: familia.id },
      conversa.enviar
    )
    const baloes = dividirEmBaloes(texto)
    for (let i = 0; i < baloes.length; i++) {
      const wid = await enviar(familia.telefone, baloes[i])
      await supabase.from('mensagens').insert({
        lead_id: caso.lead_id,
        direcao: 'out_ia',
        agente: caso.agente,
        agente_origem: 'conversa',
        conteudo: baloes[i],
        whatsapp_message_id: wid,
        ...conversa.carimbo,
      })
      if (i < baloes.length - 1) await sleep(900)
    }
    await registrar('retorno_enviado', { acao })
    return 'enviado'
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300)
    console.error('[casos] retorno falhou:', caso.id, msg)
    await registrar('retorno_falhou', { erro: msg })
    // Devolve a marca para o heartbeat tentar de novo — até MAX_FALHAS.
    const { count } = await supabase
      .from('caso_eventos')
      .select('id', { count: 'exact', head: true })
      .eq('caso_id', caso.id)
      .eq('tipo', 'retorno_falhou')
    if ((count ?? 0) < MAX_FALHAS) {
      await supabase.from('casos').update({ retorno_pendente_em: new Date().toISOString() }).eq('id', caso.id)
    }
    return 'falhou'
  }
}

async function registrarRetornoPulado(supabase: SupaAdmin, caso: Caso, motivo: string) {
  await supabase.from('caso_eventos').insert({ caso_id: caso.id, tipo: 'retorno_pulado', ator: 'sistema', detalhe: { motivo } })
  await supabase.from('eventos_timeline').insert({
    lead_id: caso.lead_id,
    tipo: 'anotacao',
    descricao: `Caso #C${caso.numero}: a IA está pausada neste contato e NÃO comunicou a decisão da equipe ("${caso.nota_equipe ?? ''}"). Repasse manualmente.`,
  })
}

/** Rede de segurança do heartbeat: retornos cujo after() morreu. */
export async function reprocessarRetornosPendentes(supabase: SupaAdmin, limite = 5): Promise<number> {
  const corte = new Date(Date.now() - 5 * 60_000).toISOString()
  const { data } = await supabase
    .from('casos')
    .select('id')
    .not('retorno_pendente_em', 'is', null)
    .lt('retorno_pendente_em', corte)
    .limit(limite)
  let n = 0
  for (const c of data ?? []) {
    if ((await executarRetornoCaso(c.id, supabase)) === 'enviado') n++
  }
  return n
}
