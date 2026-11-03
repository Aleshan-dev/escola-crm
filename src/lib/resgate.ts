import type { createServerAdminClient } from '@/lib/supabase-server'
import { acionarIAParaLead } from '@/lib/acionar-ia'

type Admin = ReturnType<typeof createServerAdminClient>

// ============================================================================
// REDE DE SEGURANÇA — resgate de leads mudos.
//
// Quando o turno da IA estoura o maxDuration do webhook, a Vercel MATA a função no
// meio: nenhum balão sai, a trava `resposta_lock_em` (tomada no início do ramo da
// Sara) fica PRESA porque o finally não roda, e nada é logado — o catch também é
// pulado. Resultado: a Sara "fica muda" e, como ela só responde a mensagem nova,
// o lead fica em silêncio para sempre. Foi o que aconteceu com o lead Vitor em
// 30/10/2026 (respondeu "Integral" ao período; webhook morto por "Task timed out
// after 60 seconds"). Ver [[protecao-envio-e-roteador-intencao]] / análise 30/10.
//
// Esta varredura acha leads cuja ÚLTIMA mensagem é de ENTRADA sem resposta depois e
// redispara a IA (mesma via do botão "responder agora"). Roda EM PROCESSO a partir
// do heartbeat (ADR-008: cron dedicado da Vercel já morreu sozinho 2x — não criamos
// outro), com teto de tempo e cota por execução para não apertar o resto do heartbeat.
// ============================================================================

const LOCK_TTL_MS = 60_000 // igual ao mutex de atendimento.ts: trava mais velha = execução morta
const PISO_MS = 3 * 60_000 // dá ao caminho normal (debounce 15s + geração) tempo de terminar
const TETO_MS = 12 * 60 * 60_000 // não ressuscita conversa antiga: responder horas depois soa estranho
const MAX_RESGATES = 3 // cota por execução (cada resgate é uma chamada ao modelo)

export type ResumoResgate = {
  candidatos: number
  resgatados: number
  falhas: number
  detalhes: { leadId: string; resultado: string }[]
}

/**
 * Acha leads mudos (última msg = entrada, sem out_ia depois, trava livre/obsoleta)
 * e redispara a IA. Idempotente: a própria `acionarIAParaLead` toma a trava e, uma
 * vez respondido, o lead deixa de casar o critério na próxima varredura.
 */
export async function resgatarLeadsMudos(
  supabase: Admin,
  opts?: { agoraMs?: number; orcamentoMs?: number }
): Promise<ResumoResgate> {
  const agora = opts?.agoraMs ?? Date.now()
  const orcamentoMs = opts?.orcamentoMs ?? 60_000
  const inicio = Date.now()

  const resumo: ResumoResgate = { candidatos: 0, resgatados: 0, falhas: 0, detalhes: [] }

  // 1) Última mensagem de cada lead na janela [agora-TETO, agora-PISO]. Em ordem
  //    decrescente, a PRIMEIRA linha vista por lead é a mais recente.
  const { data: msgs } = await supabase
    .from('mensagens')
    .select('lead_id, direcao, criado_em')
    .gte('criado_em', new Date(agora - TETO_MS).toISOString())
    .order('criado_em', { ascending: false })
    .limit(2000)

  if (!msgs || msgs.length === 0) return resumo

  const ultimaPorLead = new Map<string, { direcao: string; criado_em: string }>()
  for (const m of msgs as { lead_id: string; direcao: string; criado_em: string }[]) {
    if (!m.lead_id || ultimaPorLead.has(m.lead_id)) continue
    ultimaPorLead.set(m.lead_id, { direcao: m.direcao, criado_em: m.criado_em })
  }

  // Candidato: última mensagem é 'in' e já passou do piso (não estamos competindo
  // com o caminho normal, que ainda pode estar no debounce/gerando).
  const candidatos: string[] = []
  for (const [leadId, ult] of ultimaPorLead) {
    if (ult.direcao !== 'in') continue
    if (new Date(ult.criado_em).getTime() > agora - PISO_MS) continue
    candidatos.push(leadId)
  }
  resumo.candidatos = candidatos.length
  if (candidatos.length === 0) return resumo

  const obsoleto = agora - LOCK_TTL_MS

  for (const leadId of candidatos) {
    if (resumo.resgatados >= MAX_RESGATES) break
    if (Date.now() - inicio > orcamentoMs) break

    // Guardas por lead: só captação com IA ativa e sem resposta em andamento.
    const { data: lead } = await supabase
      .from('leads')
      .select('id, ia_ativa, arquivado, precisa_atendimento_humano, resposta_lock_em, familia:familias(opt_out_em, ja_responsavel)')
      .eq('id', leadId)
      .maybeSingle<{
        id: string
        ia_ativa: boolean
        arquivado: boolean
        precisa_atendimento_humano: boolean
        resposta_lock_em: string | null
        familia: { opt_out_em: string | null; ja_responsavel: boolean } | null
      }>()

    if (!lead) continue
    if (lead.ia_ativa !== true) continue
    if (lead.arquivado === true) continue
    if (lead.precisa_atendimento_humano === true) continue
    if (lead.familia?.opt_out_em) continue
    // Matriculado tem a própria via (Salomão/dispatch); esta rede é para a Sara.
    if (lead.familia?.ja_responsavel === true) continue
    // Trava FRESCA = uma resposta está saindo agora; não atropela.
    if (lead.resposta_lock_em && new Date(lead.resposta_lock_em).getTime() > obsoleto) continue

    try {
      const r = await acionarIAParaLead(leadId)
      if (r.ok) {
        resumo.resgatados++
        resumo.detalhes.push({ leadId, resultado: `ok:${r.agente}` })
      } else {
        resumo.falhas++
        resumo.detalhes.push({ leadId, resultado: r.janela_fechada ? 'janela_fechada' : `erro:${r.error ?? '?'}` })
      }
    } catch (e) {
      resumo.falhas++
      resumo.detalhes.push({ leadId, resultado: `excecao:${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return resumo
}
