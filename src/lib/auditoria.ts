/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'

// Auditoria diária do atendimento da Sara: cruza checagens determinísticas (o que
// dá pra medir no banco) com uma avaliação por IA de cada conversa, num gabarito
// de 10 critérios + entregáveis (pontos fortes, oportunidades, reescritas, etc.).

type Supa = ReturnType<typeof createServerAdminClient>

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

// Regras que a Sara deve seguir (do manual + guard-rails). Contexto do avaliador.
const REGRAS = `REGRAS QUE A SARA DEVE SEGUIR:
- Personalizar (nome e gênero certos; nunca confundir nome da criança com o do responsável).
- Coletar os dados obrigatórios (nome/idade/série/período da criança; de cada irmão) antes de avançar.
- Nunca inventar preço, endereço, professora ou dado fora da base (anti-alucinação).
- Mensagens curtas e acolhedoras (balões), tom cristão e profissional.
- Só agendar/confirmar visita com data e horário específicos; oferecer só horários livres; reagendar = atualizar a visita; não marcar "realizada" antes da data.
- Não oferecer turma sem vaga.
- Fazer transbordo quando o lead pede humano/coordenação, reclama, ou após dizer "vou verificar" 2+ vezes.
- Follow-up personalizado, sem repetir e sem pressionar.`

export type CriteriosAval = {
  acolhimento: number
  humanizacao: number
  diagnostico: number
  escuta_ativa: number
  construcao_valor: number
  objecoes: number
  convite_visita: number
  comunicacao: number
  followup: number
  probabilidade_matricula: number
}
export type MensagemReescrita = { original: string; sugestao: string }
export type DetalheConversa = {
  lead_id: string
  responsavel: string
  nota: number
  criterios: CriteriosAval
  pontos_fortes: string[]
  oportunidades: string[]
  mensagens_reescrever: MensagemReescrita[]
  melhor_resposta: string
  proxima_acao: string
  classificacao: string
  estagio_funil: string
  resumo: string
}

// ---------------------------------------------------------------------------
// Checagens determinísticas (sinais objetivos do banco)
// ---------------------------------------------------------------------------
async function checagensDeterministicas(supabase: Supa, inicioIso: string): Promise<string[]> {
  const achados: string[] = []

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

  const { data: recusas } = await supabase
    .from('acoes_sara')
    .select('razao')
    .eq('tipo', 'movimentacao')
    .eq('sucesso', false)
    .gte('criado_em', inicioIso)
  if (recusas && recusas.length) {
    const cont: Record<string, number> = {}
    for (const r of recusas as any[]) cont[r.razao || 'desconhecido'] = (cont[r.razao || 'desconhecido'] || 0) + 1
    achados.push(`Movimentações indevidas bloqueadas pelo sistema: ${Object.entries(cont).map(([k, v]) => `${k}: ${v}x`).join(', ')}.`)
  }

  const { data: fams } = await supabase
    .from('familias')
    .select('nome_responsavel, criancas(nome)')
    .gte('atualizado_em', inicioIso)
  for (const f of (fams || []) as any[]) {
    const nr = (f.nome_responsavel || '').trim().toLowerCase()
    if (!nr) continue
    const bate = (f.criancas || []).some((c: any) => {
      const cn = (c.nome || '').trim().toLowerCase()
      return cn && nr.includes(cn)
    })
    if (bate) achados.push(`Possível confusão de nome: responsável "${f.nome_responsavel}" parece ter o nome de uma criança da família.`)
  }

  return achados
}

// ---------------------------------------------------------------------------
// Avaliação de uma conversa por IA (gabarito completo)
// ---------------------------------------------------------------------------
const N0 = (v: any, max = 10) => (typeof v === 'number' ? Math.max(0, Math.min(max, Math.round(v))) : 0)
const S = (v: any) => (typeof v === 'string' ? v : '')
const ARR = (v: any): any[] => (Array.isArray(v) ? v : [])

async function avaliarConversa(responsavel: string, estagioAtual: string, transcript: string): Promise<Omit<DetalheConversa, 'lead_id' | 'responsavel'>> {
  const prompt = `Você é auditor de qualidade de vendas consultivas. Avalie o desempenho da "Sara" (assistente de matrículas de uma escola infantil cristã) na conversa abaixo.
${REGRAS}

Dê uma nota de 0 a 10 para cada critério (10 = probabilidade em %):
1. Acolhimento, 2. Humanização, 3. Diagnóstico, 4. Escuta ativa, 5. Construção de valor, 6. Tratamento de objeções, 7. Convite para visita, 8. Comunicação, 9. Follow-up, 10. Probabilidade de matrícula (0–100%).

Depois entregue: nota geral (0–100), 3 pontos fortes, 3 oportunidades de melhoria, mensagens que poderiam ser reescritas (com a versão melhor), a melhor resposta sugerida agora, a próxima melhor ação, a classificação do lead (Frio, Morno ou Quente), o estágio do funil, e um resumo executivo (≤100 palavras).

Responda SOMENTE em JSON:
{
 "criterios": {"acolhimento":0,"humanizacao":0,"diagnostico":0,"escuta_ativa":0,"construcao_valor":0,"objecoes":0,"convite_visita":0,"comunicacao":0,"followup":0,"probabilidade_matricula":0},
 "nota_geral": 0,
 "pontos_fortes": ["","",""],
 "oportunidades": ["","",""],
 "mensagens_reescrever": [{"original":"","sugestao":""}],
 "melhor_resposta": "",
 "proxima_acao": "",
 "classificacao": "Frio|Morno|Quente",
 "estagio_funil": "",
 "resumo": ""
}

Estágio atual do lead no CRM: ${estagioAtual || 'desconhecido'}.
CONVERSA (responsável: ${responsavel}):
${transcript}`

  try {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 1100,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    })
    const j = JSON.parse(resp.choices[0]?.message?.content || '{}')
    const c = j.criterios || {}
    return {
      nota: N0(j.nota_geral, 100),
      criterios: {
        acolhimento: N0(c.acolhimento),
        humanizacao: N0(c.humanizacao),
        diagnostico: N0(c.diagnostico),
        escuta_ativa: N0(c.escuta_ativa),
        construcao_valor: N0(c.construcao_valor),
        objecoes: N0(c.objecoes),
        convite_visita: N0(c.convite_visita),
        comunicacao: N0(c.comunicacao),
        followup: N0(c.followup),
        probabilidade_matricula: N0(c.probabilidade_matricula, 100),
      },
      pontos_fortes: ARR(j.pontos_fortes).map(S).filter(Boolean).slice(0, 3),
      oportunidades: ARR(j.oportunidades).map(S).filter(Boolean).slice(0, 3),
      mensagens_reescrever: ARR(j.mensagens_reescrever)
        .map((m: any) => ({ original: S(m?.original), sugestao: S(m?.sugestao) }))
        .filter((m) => m.original || m.sugestao)
        .slice(0, 4),
      melhor_resposta: S(j.melhor_resposta),
      proxima_acao: S(j.proxima_acao),
      classificacao: S(j.classificacao) || '—',
      estagio_funil: S(j.estagio_funil) || estagioAtual || '—',
      resumo: S(j.resumo),
    }
  } catch (e) {
    console.error('[auditoria] avaliação falhou:', e instanceof Error ? e.message : e)
    return {
      nota: 0,
      criterios: { acolhimento: 0, humanizacao: 0, diagnostico: 0, escuta_ativa: 0, construcao_valor: 0, objecoes: 0, convite_visita: 0, comunicacao: 0, followup: 0, probabilidade_matricula: 0 },
      pontos_fortes: [], oportunidades: [], mensagens_reescrever: [], melhor_resposta: '', proxima_acao: '', classificacao: '—', estagio_funil: estagioAtual || '—', resumo: 'Falha ao analisar esta conversa.',
    }
  }
}

// Roll-up do dia: resumo executivo + sugestões priorizadas (a partir das oportunidades).
async function agregar(detalhes: DetalheConversa[], achadosDet: string[]): Promise<{ resumo: string; sugestoes: string[] }> {
  const oport = detalhes.flatMap((d) => d.oportunidades)
  const material = `SINAIS DO SISTEMA:\n${achadosDet.join('\n') || '(nenhum)'}\n\nOPORTUNIDADES NAS CONVERSAS:\n${oport.join('\n') || '(nenhuma)'}`
  const prompt = `Você é o supervisor da Sara (assistente de matrículas). Com base nos achados do dia abaixo, escreva um "resumo" executivo (2-4 frases) e "sugestoes": 3 a 6 correções concretas e priorizadas (ajuste de prompt, regra ou processo). Responda em JSON {"resumo":"","sugestoes":[]}.

${material}`
  try {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    })
    const j = JSON.parse(resp.choices[0]?.message?.content || '{}')
    return { resumo: S(j.resumo) || 'Sem resumo.', sugestoes: ARR(j.sugestoes).map(S).filter(Boolean) }
  } catch {
    return { resumo: 'Não foi possível gerar o resumo do dia.', sugestoes: [] }
  }
}

// ---------------------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------------------
export async function rodarAuditoria(supabase: Supa, horas = 24, maxConversas = 8): Promise<{ id: string | null }> {
  const fim = new Date()
  const inicio = new Date(fim.getTime() - horas * 60 * 60 * 1000)
  const inicioIso = inicio.toISOString()

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
      .select('id, familia:familias(nome_responsavel), coluna:colunas(nome)')
      .eq('id', leadId)
      .single()
    const responsavel = (lead as any)?.familia?.nome_responsavel || 'Responsável'
    const estagio = (lead as any)?.coluna?.nome || ''

    const { data: conversa } = await supabase
      .from('mensagens')
      .select('direcao, conteudo')
      .eq('lead_id', leadId)
      .order('criado_em', { ascending: true })
      .limit(80)

    const transcript = (conversa || [])
      .map((m: any) => `${m.direcao === 'in' ? 'Família' : m.direcao === 'out_ia' ? 'Sara' : 'Equipe'}: ${m.conteudo}`)
      .join('\n')
      .slice(-7000)

    const aval = await avaliarConversa(responsavel, estagio, transcript)
    detalhes.push({ lead_id: leadId, responsavel, ...aval })
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
