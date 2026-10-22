/**
 * MEMÓRIA DO LEAD — extração automática (o equivalente do "flush antes da
 * compactação" do DeskcommCRM). A Sara/Salomão só veem as 20 últimas mensagens; o
 * que sai dessa janela some do prompt. O heartbeat pega os leads com mensagens fora
 * da janela ainda não lidas (crm.memoria_leads_pendentes), passa esse trecho + a
 * memória atual a um extrator curto e grava pela RPC. O cursor
 * leads.memoria_extraida_ate só avança depois da leitura — falha = tenta de novo.
 * Roda fora do turno: não soma latência ao atendimento.
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import { chamarModeloIA } from '@/lib/ia-credenciais'
import { blocoMemoria, parseMemoriaSalvar } from './regras'
import { carregarMemoria, lerConfigMemoria, salvarNota } from './servico'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

const MSGS_POR_LOTE = 80

export async function extrairMemoriaDoLead(
  supabase: SupaAdmin,
  leadId: string,
  corte: string,
  cursor: string | null,
  orcamento: number,
  modelo: string
): Promise<{ gravadas: number; falhas: number }> {
  let q = supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .lte('criado_em', corte)
    .order('criado_em')
    .limit(MSGS_POR_LOTE)
  if (cursor) q = q.gt('criado_em', cursor)
  const { data: msgs } = await q
  const lote = (msgs ?? []).filter((m) => m.conteudo)
  const novoCursor = msgs?.length ? msgs[msgs.length - 1].criado_em : corte

  if (!lote.some((m) => m.direcao === 'in')) {
    await supabase.from('leads').update({ memoria_extraida_ate: novoCursor }).eq('id', leadId)
    return { gravadas: 0, falhas: 0 }
  }

  const { notas, mapa } = await carregarMemoria(supabase, leadId)
  const conversa = lote
    .map((m) => `${m.direcao === 'in' ? 'FAMÍLIA' : 'ESCOLA'} (${String(m.criado_em).slice(0, 10)}): ${m.conteudo}`)
    .join('\n')

  const sistema = `Você mantém a MEMÓRIA de longo prazo de uma família no CRM de uma escola de educação infantil.
Abaixo vem a memória atual e um trecho ANTIGO da conversa de WhatsApp, que vai sair do contexto do atendente virtual.
Extraia do trecho SÓ fatos duráveis que ainda não estejam na memória e que valha lembrar daqui a semanas.
Use apenas o que a FAMÍLIA disse ou o que ficou combinado; nunca invente. Datas sempre absolutas (DD/MM/AAAA).
${blocoMemoria(notas, orcamento)}

Se nada novo durável: {"memoria_salvar": []}.
Responda SOMENTE JSON: {"memoria_salvar": [{"titulo": "...", "corpo": "...", "substitui": []}]}`

  const raw = await chamarModeloIA(
    'sara',
    {
      messages: [
        { role: 'system', content: sistema },
        { role: 'user', content: conversa },
      ],
      model: modelo,
      maxTokens: 500,
      jsonMode: true,
    },
    supabase
  )
  // JSON inválido conta como "nada a gravar" e o cursor avança: repetir o mesmo
  // trecho a cada heartbeat só gastaria chamada paga.
  let bruto: unknown = []
  try {
    bruto = JSON.parse(raw || '{}').memoria_salvar
  } catch {
    console.warn(`[memoria/extracao] saída não é JSON (lead ${leadId})`)
  }
  const pedidos = parseMemoriaSalvar(bruto, mapa)

  let gravadas = 0
  let falhas = 0
  for (const p of pedidos) {
    const r = await salvarNota(supabase, {
      leadId, titulo: p.titulo, corpo: p.corpo, origem: 'extracao', substitui: p.substitui, orcamento,
    })
    if (r.ok) gravadas++
    else {
      falhas++
      console.warn(`[memoria/extracao] não gravou nota (lead ${leadId}): ${r.motivo}`)
    }
  }
  await supabase.from('leads').update({ memoria_extraida_ate: novoCursor }).eq('id', leadId)
  return { gravadas, falhas }
}

/** Uma rodada do heartbeat: até `limite` leads, com teto de tempo. */
export async function extrairMemoriasPendentes(
  supabase: SupaAdmin,
  opts: { limite?: number; orcamentoMs?: number } = {}
): Promise<{ leads: number; gravadas: number; erros: number } | { pulado: string }> {
  const cfg = await lerConfigMemoria(supabase)
  if (!cfg.ativa) return { pulado: 'memoria_desligada' }

  const { data: pendentes, error } = await supabase.rpc('memoria_leads_pendentes', { p_limite: opts.limite ?? 5 })
  if (error) throw new Error(`memoria_leads_pendentes: ${error.message}`)

  const { data: conf } = await supabase.from('config_ia').select('modelo').eq('id', 1).maybeSingle()
  const modelo = conf?.modelo?.trim() || 'gpt-4o'
  const inicio = Date.now()
  const teto = opts.orcamentoMs ?? 25_000
  let leads = 0, gravadas = 0, erros = 0

  for (const p of (pendentes ?? []) as { lead_id: string; corte: string; cursor: string | null }[]) {
    if (Date.now() - inicio > teto) break
    try {
      const r = await extrairMemoriaDoLead(supabase, p.lead_id, p.corte, p.cursor, cfg.orcamento, modelo)
      leads++
      gravadas += r.gravadas
    } catch (e) {
      erros++
      console.error('[memoria/extracao] falhou', p.lead_id, e instanceof Error ? e.message : e)
    }
  }
  return { leads, gravadas, erros }
}
