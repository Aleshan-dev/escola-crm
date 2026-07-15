/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'

// Auditoria diária do atendimento da Sara: cruza checagens determinísticas (o que
// dá pra medir no banco) com uma revisão por IA das conversas do dia, contra as
// regras propostas. Gera nota, achados e sugestões de correção.

type Supa = ReturnType<typeof createServerAdminClient>

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

// Regras que a Sara deve seguir (do manual + guard-rails do sistema). É o gabarito da auditoria.
const REGRAS = `REGRAS QUE A SARA DEVE SEGUIR:
1. PERSONALIZAÇÃO: chamar o responsável pelo primeiro nome e no gênero certo. NUNCA confundir o nome da criança com o do responsável. Se o nome do perfil parecer ser o da criança, perguntar o nome do responsável.
2. DADOS OBRIGATÓRIOS: coletar nome da criança, idade, série/turma e período (um de cada vez) antes de avançar a etapa. Se houver irmãos, coletar de cada criança.
3. ANTI-ALUCINAÇÃO: nunca inventar preço, endereço, nome de professora ou qualquer dado fora da base. Se não souber, dizer que vai verificar com a equipe.
4. BALÕES CURTOS: mensagens curtas e acolhedoras, sem textão.
5. VISITA: só confirmar/agendar visita com data e horário específicos; oferecer só horários realmente livres; ao reagendar, atualizar a visita existente (não criar outra); não dizer que a visita foi realizada antes de a data passar.
6. VAGAS: não oferecer turma sem vaga; se lotada, oferecer lista de espera ou turma próxima com vaga.
7. TRANSBORDO: acionar atendimento humano quando o lead pede humano/coordenação, faz reclamação grave, ou quando ela já disse "vou verificar com a equipe" 2+ vezes.
8. FOLLOW-UP: mensagens de retomada personalizadas (usando o que já foi conversado), sem repetir mensagens anteriores nem pressionar.
9. TOM: acolhedor, cristão, profissional; não prometer o que não pode cumprir.`

export type ProblemaConversa = { regra: string; descricao: string; gravidade: 'baixa' | 'media' | 'alta' }
export type DetalheConversa = {
  lead_id: string
  responsavel: string
  nota: number
  problemas: ProblemaConversa[]
  acertos: string[]
}

// ---------------------------------------------------------------------------
// 1) Checagens determinísticas (sinais objetivos do banco)
// ---------------------------------------------------------------------------
async function checagensDeterministicas(supabase: Supa, inicioIso: string): Promise<string[]> {
  const achados: string[] = []

  // a) Leads em etapa "Visita Agendada" sem nenhuma tarefa de visita
  const { data: colsVisita } = await supabase.from('colunas').select('id, nome').ilike('nome', '%visita agendada%')
  const idsVisitaAgendada = (colsVisita || []).map((c: any) => c.id)
  if (idsVisitaAgendada.length) {
    const { data: leadsVA } = await supabase
      .from('leads')
      .select('id, familia:familias(nome_responsavel)')
      .in('coluna_id', idsVisitaAgendada)
      .eq('arquivado', false)
    for (const l of (leadsVA || []) as any[]) {
      const { count } = await supabase
        .from('tarefas')
        .select('id', { count: 'exact', head: true })
        .eq('lead_id', l.id)
        .eq('tipo', 'visita')
      if (!count) achados.push(`Lead "${l.familia?.nome_responsavel || l.id}" está em "Visita Agendada" mas não tem tarefa de visita.`)
    }
  }

  // b) Recusas de movimentação da Sara no período (tentou mover errado)
  const { data: recusas } = await supabase
    .from('acoes_sara')
    .select('razao')
    .eq('tipo', 'movimentacao')
    .eq('sucesso', false)
    .gte('criado_em', inicioIso)
  if (recusas && recusas.length) {
    const cont: Record<string, number> = {}
    for (const r of recusas as any[]) cont[r.razao || 'desconhecido'] = (cont[r.razao || 'desconhecido'] || 0) + 1
    const resumoRec = Object.entries(cont).map(([k, v]) => `${k}: ${v}x`).join(', ')
    achados.push(`A Sara tentou mover leads de forma indevida (bloqueado pelo sistema): ${resumoRec}.`)
  }

  // c) Possível confusão nome do responsável = nome de criança da família
  const { data: fams } = await supabase
    .from('familias')
    .select('nome_responsavel, criancas(nome)')
    .gte('atualizado_em', inicioIso)
  for (const f of (fams || []) as any[]) {
    const nr = (f.nome_responsavel || '').trim().toLowerCase()
    if (!nr) continue
    const bate = (f.criancas || []).some((c: any) => (c.nome || '').trim().toLowerCase() && nr.includes((c.nome || '').trim().toLowerCase()))
    if (bate) achados.push(`Possível confusão de nome: responsável "${f.nome_responsavel}" parece ter o nome de uma criança da família.`)
  }

  return achados
}

// ---------------------------------------------------------------------------
// 2) Revisão de uma conversa por IA
// ---------------------------------------------------------------------------
async function revisarConversa(
  responsavel: string,
  transcript: string
): Promise<{ nota: number; problemas: ProblemaConversa[]; acertos: string[] }> {
  const prompt = `Você é auditor de qualidade do atendimento da "Sara", assistente de matrículas de uma escola infantil.
${REGRAS}

Analise a conversa abaixo (Família = lead; Sara = assistente) e avalie SÓ o desempenho da Sara.
Responda em JSON: {"nota": 0-100, "problemas": [{"regra":"nº ou tema","descricao":"o que ela errou","gravidade":"baixa|media|alta"}], "acertos": ["pontos positivos"]}.
Seja específico e cite a regra. Se não houver problemas, "problemas": [].

CONVERSA (responsável: ${responsavel}):
${transcript}`

  try {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    })
    const j = JSON.parse(resp.choices[0]?.message?.content || '{}')
    return {
      nota: typeof j.nota === 'number' ? j.nota : 70,
      problemas: Array.isArray(j.problemas) ? j.problemas : [],
      acertos: Array.isArray(j.acertos) ? j.acertos : [],
    }
  } catch (e) {
    console.error('[auditoria] revisão de conversa falhou:', e instanceof Error ? e.message : e)
    return { nota: 0, problemas: [{ regra: 'sistema', descricao: 'Falha ao analisar', gravidade: 'baixa' }], acertos: [] }
  }
}

// ---------------------------------------------------------------------------
// 3) Agregação (resumo executivo + sugestões priorizadas)
// ---------------------------------------------------------------------------
async function agregar(
  detalhes: DetalheConversa[],
  achadosDet: string[]
): Promise<{ resumo: string; sugestoes: string[] }> {
  const problemasFlat = detalhes.flatMap((d) => d.problemas.map((p) => `[${p.gravidade}] ${p.regra}: ${p.descricao}`))
  const material = `SINAIS DO SISTEMA:\n${achadosDet.join('\n') || '(nenhum)'}\n\nPROBLEMAS NAS CONVERSAS:\n${problemasFlat.join('\n') || '(nenhum)'}`

  const prompt = `Você é o supervisor da Sara (assistente de matrículas). Com base nos achados de hoje abaixo, escreva:
1. um "resumo" executivo (2-4 frases) do desempenho da Sara hoje;
2. "sugestoes": lista de 3 a 6 correções CONCRETAS e acionáveis (ajuste de prompt, regra, ou processo), priorizadas por impacto.
Responda em JSON: {"resumo":"...","sugestoes":["...","..."]}.

${material}`

  try {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    })
    const j = JSON.parse(resp.choices[0]?.message?.content || '{}')
    return {
      resumo: typeof j.resumo === 'string' ? j.resumo : 'Sem resumo.',
      sugestoes: Array.isArray(j.sugestoes) ? j.sugestoes : [],
    }
  } catch {
    return { resumo: 'Não foi possível gerar o resumo.', sugestoes: [] }
  }
}

// ---------------------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------------------
export async function rodarAuditoria(supabase: Supa, horas = 24, maxConversas = 8): Promise<{ id: string | null }> {
  const fim = new Date()
  const inicio = new Date(fim.getTime() - horas * 60 * 60 * 1000)
  const inicioIso = inicio.toISOString()

  // Leads com atividade da Sara (out_ia) no período
  const { data: msgs } = await supabase
    .from('mensagens')
    .select('lead_id')
    .eq('direcao', 'out_ia')
    .gte('criado_em', inicioIso)
    .order('criado_em', { ascending: false })

  const leadIds = Array.from(new Set((msgs || []).map((m: any) => m.lead_id))).slice(0, maxConversas)

  const detalhes: DetalheConversa[] = []
  for (const leadId of leadIds) {
    const { data: lead } = await supabase
      .from('leads')
      .select('id, familia:familias(nome_responsavel)')
      .eq('id', leadId)
      .single()
    const responsavel = (lead as any)?.familia?.nome_responsavel || 'Responsável'

    const { data: conversa } = await supabase
      .from('mensagens')
      .select('direcao, conteudo, criado_em')
      .eq('lead_id', leadId)
      .order('criado_em', { ascending: true })
      .limit(60)

    const transcript = (conversa || [])
      .map((m: any) => `${m.direcao === 'in' ? 'Família' : m.direcao === 'out_ia' ? 'Sara' : 'Equipe'}: ${m.conteudo}`)
      .join('\n')
      .slice(-6000)

    const rev = await revisarConversa(responsavel, transcript)
    detalhes.push({ lead_id: leadId, responsavel, ...rev })
  }

  const achadosDet = await checagensDeterministicas(supabase, inicioIso)
  const { resumo, sugestoes } = await agregar(detalhes, achadosDet)

  const notas = detalhes.map((d) => d.nota).filter((n) => n > 0)
  const notaGeral = notas.length ? Math.round(notas.reduce((a, b) => a + b, 0) / notas.length) : null

  const { data: ins } = await supabase
    .from('auditorias_sara')
    .insert({
      periodo_inicio: inicioIso,
      periodo_fim: fim.toISOString(),
      conversas_analisadas: detalhes.length,
      nota_geral: notaGeral,
      resumo,
      achados: achadosDet,
      sugestoes,
      detalhes,
    })
    .select('id')
    .single()

  return { id: (ins as any)?.id ?? null }
}
