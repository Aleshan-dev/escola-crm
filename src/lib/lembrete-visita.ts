import type { createServerAdminClient } from '@/lib/supabase-server'
import { notificarGestor } from '@/lib/notificacoes'
import { labelAcre } from '@/lib/disponibilidade'
import { formatarIdade } from '@/lib/idade'

type Admin = ReturnType<typeof createServerAdminClient>

// ============================================================================
// RESUMO PRÉ-VISITA — briefing para o atendimento presencial.
//
// ~30 min antes de cada visita agendada, manda ao WhatsApp do gestor
// (config_ia.telefone_transbordo, o mesmo canal dos avisos de visita) um resumo
// do lead: criança, responsável, o que a família busca, leitura da IA, memória
// durável e anotações da equipe — o que ajuda a receber a família bem na porta.
//
// GATILHO (ADR-008): não criamos um cron dedicado — já morreram sozinhos 2x. Esta
// varredura roda a partir do cron de follow-up (*/15, boa precisão para "meia hora
// antes") E do heartbeat (*/30, rede de segurança). Idempotente por claim-lock em
// tarefas.resumo_pre_visita_em, então rodar pelas duas origens não duplica o envio.
//
// Independe de followup_ativo/horário comercial: visitas já caem no horário de
// atendimento, e o briefing precisa sair mesmo com o follow-up pausado.
// ============================================================================

// Janela de antecedência. Com o cron de */15 o resumo sai 20–35 min antes; o
// heartbeat de */30 cobre o caso do cron dedicado ter morrido.
const ANTECEDENCIA_MS = 35 * 60_000
const MAX_RESUMOS = 5 // teto por execução (poucas visitas cabem numa janela de 35 min)

export type ResumoPreVisita = {
  candidatas: number
  enviados: number
  pulados: number
  falhas: number
  detalhes: { tarefaId: string; resultado: string }[]
}

type LeadBriefing = {
  temperatura: string | null
  escola_atual: string | null
  primeira_experiencia: string | null
  motivo_busca: string | null
  quando_iniciar: string | null
  cog_interesse: number | null
  cog_urgencia: number | null
  cog_proxima_acao: string | null
  visita_confirmada_em: string | null
  reagendamentos_count: number | null
  familia: {
    nome_responsavel: string | null
    telefone: string | null
    canal: string | null
    campanha: string | null
    tipo_responsavel: string | null
    bairro: string | null
    cidade: string | null
  } | null
  crianca: {
    nome: string | null
    idade: number | null
    idade_meses: number | null
    serie_desejada: string | null
    periodo: string | null
    motivo_busca: string | null
  } | null
}

/**
 * Acha visitas que começam nos próximos ~35 min e ainda sem resumo enviado, e manda
 * o briefing ao gestor. Idempotente: o claim-lock em resumo_pre_visita_em garante um
 * único envio mesmo quando cron de follow-up e heartbeat rodam quase juntos.
 */
export async function enviarResumosPreVisita(
  supabase: Admin,
  opts?: { agoraMs?: number }
): Promise<ResumoPreVisita> {
  const agora = opts?.agoraMs ?? Date.now()
  const resumo: ResumoPreVisita = { candidatas: 0, enviados: 0, pulados: 0, falhas: 0, detalhes: [] }

  const { data: visitas } = await supabase
    .from('tarefas')
    .select('id, lead_id, data_hora')
    .eq('tipo', 'visita')
    .eq('concluida', false)
    .is('resumo_pre_visita_em', null)
    .gt('data_hora', new Date(agora).toISOString())
    .lte('data_hora', new Date(agora + ANTECEDENCIA_MS).toISOString())
    .order('data_hora', { ascending: true })
    .limit(MAX_RESUMOS)

  const linhas = (visitas as { id: string; lead_id: string | null; data_hora: string }[] | null) || []
  resumo.candidatas = linhas.length
  if (linhas.length === 0) return resumo

  for (const v of linhas) {
    if (!v.lead_id) {
      resumo.pulados++
      resumo.detalhes.push({ tarefaId: v.id, resultado: 'sem_lead' })
      continue
    }

    // CLAIM-LOCK: carimba resumo_pre_visita_em só se ainda estiver nulo. Se outra
    // execução (cron + heartbeat) já pegou esta visita, o update não casa nenhuma
    // linha e nós pulamos — nunca envia duas vezes.
    const { data: claim } = await supabase
      .from('tarefas')
      .update({ resumo_pre_visita_em: new Date().toISOString() })
      .eq('id', v.id)
      .is('resumo_pre_visita_em', null)
      .select('id')
    if (!claim || claim.length === 0) {
      resumo.pulados++
      resumo.detalhes.push({ tarefaId: v.id, resultado: 'ja_enviado' })
      continue
    }

    try {
      const { data: lead } = await supabase
        .from('leads')
        .select(
          `temperatura, escola_atual, primeira_experiencia, motivo_busca, quando_iniciar,
           cog_interesse, cog_urgencia, cog_proxima_acao,
           visita_confirmada_em, reagendamentos_count,
           familia:familias(nome_responsavel, telefone, canal, campanha, tipo_responsavel, bairro, cidade),
           crianca:criancas(nome, idade, idade_meses, serie_desejada, periodo, motivo_busca)`
        )
        .eq('id', v.lead_id)
        .maybeSingle<LeadBriefing>()

      const [{ data: memorias }, { data: anotacoes }] = await Promise.all([
        supabase
          .from('memoria_lead')
          .select('titulo, corpo')
          .eq('lead_id', v.lead_id)
          .is('arquivada_em', null)
          .order('criado_em', { ascending: false })
          .limit(6),
        supabase
          .from('anotacoes')
          .select('conteudo')
          .eq('lead_id', v.lead_id)
          .order('criado_em', { ascending: false })
          .limit(3),
      ])

      const mensagem = montarResumo(
        v.data_hora,
        lead ?? null,
        (memorias as { titulo: string | null; corpo: string | null }[] | null) || [],
        (anotacoes as { conteudo: string | null }[] | null) || []
      )

      // Mesmo canal/flag dos avisos de visita (honra config_ia.notif_visita_agendada).
      await notificarGestor(supabase, 'visita', mensagem)
      resumo.enviados++
      resumo.detalhes.push({ tarefaId: v.id, resultado: 'ok' })
    } catch (e) {
      resumo.falhas++
      resumo.detalhes.push({ tarefaId: v.id, resultado: `erro:${e instanceof Error ? e.message : String(e)}` })
    }
  }

  return resumo
}

function montarResumo(
  dataHora: string,
  lead: LeadBriefing | null,
  memorias: { titulo: string | null; corpo: string | null }[],
  anotacoes: { conteudo: string | null }[]
): string {
  const fam = lead?.familia ?? null
  const cri = lead?.crianca ?? null
  const L: string[] = []

  L.push(`🔔 *Visita em ~30 min* — ${labelAcre(new Date(dataHora))}`)

  // Criança
  const idade = cri ? formatarIdade(cri.idade, cri.idade_meses) : ''
  L.push('')
  L.push(`👧 *${cri?.nome || 'Criança (nome não informado)'}*${idade ? ` — ${idade}` : ''}`)
  const turma = [cri?.serie_desejada, cri?.periodo].filter(Boolean).join(' · ')
  if (turma) L.push(`🎓 ${turma}`)

  // Responsável
  L.push('')
  L.push(
    `👪 ${fam?.nome_responsavel || 'Responsável'}${fam?.tipo_responsavel ? ` (${fam.tipo_responsavel})` : ''}`
  )
  if (fam?.telefone) L.push(`📞 ${fam.telefone}`)
  const local = [fam?.bairro, fam?.cidade].filter(Boolean).join(', ')
  if (local) L.push(`📍 ${local}`)

  // Contexto da busca
  const contexto: string[] = []
  const dor = cri?.motivo_busca || lead?.motivo_busca
  if (dor) contexto.push(`🎯 Busca: ${dor}`)
  if (lead?.escola_atual) contexto.push(`🏫 Escola atual: ${lead.escola_atual}`)
  if (lead?.primeira_experiencia) contexto.push(`🍼 1ª experiência: ${lead.primeira_experiencia}`)
  if (lead?.quando_iniciar) contexto.push(`🗓️ Pretende iniciar: ${lead.quando_iniciar}`)
  const origem = [fam?.canal, fam?.campanha].filter(Boolean).join(' / ')
  if (origem) contexto.push(`📣 Veio de: ${origem}`)
  if (contexto.length) {
    L.push('')
    L.push(...contexto)
  }

  // Leitura da IA
  const leitura: string[] = []
  if (lead?.temperatura) leitura.push(lead.temperatura)
  if (lead?.cog_interesse != null) leitura.push(`interesse ${lead.cog_interesse}/10`)
  if (lead?.cog_urgencia != null) leitura.push(`urgência ${lead.cog_urgencia}/10`)
  if (leitura.length) {
    L.push('')
    L.push(`🌡️ Leitura da IA: ${leitura.join(' · ')}`)
  }
  if (lead?.cog_proxima_acao) L.push(`➡️ Sugestão: ${lead.cog_proxima_acao}`)

  // Memória durável
  const mem = memorias.filter((m) => m.titulo || m.corpo)
  if (mem.length) {
    L.push('')
    L.push('🧠 *Memória:*')
    for (const m of mem) {
      const corpo = (m.corpo || '').trim()
      L.push(`• ${[m.titulo, corpo].filter(Boolean).join(': ')}`)
    }
  }

  // Anotações da equipe
  const notas = anotacoes.map((a) => (a.conteudo || '').trim()).filter(Boolean)
  if (notas.length) {
    L.push('')
    L.push('📝 *Anotações da equipe:*')
    for (const n of notas) L.push(`• ${n}`)
  }

  // Status da visita
  L.push('')
  const reag = lead?.reagendamentos_count ?? 0
  L.push(
    `${lead?.visita_confirmada_em ? '✅ Presença confirmada' : '⚠️ Presença não confirmada'}${
      reag > 0 ? ` · já reagendou ${reag}x` : ''
    }`
  )

  return L.join('\n')
}
