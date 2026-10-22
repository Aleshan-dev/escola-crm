import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'

// ADR-006 / ADR-007 (Revisão 1): Auditor Cognitivo da Sara — Nível 1.
// Lê uma conversa encerrada, avalia contra o gabarito preditivo de COMPARECIMENTO
// e grava uma sugestão em sugestoes_auditoria (Aplicar/Rejeitar na tela /auditoria).
// É um SEGUNDO julgamento — nunca a própria Sara se auditando.

type Supa = ReturnType<typeof createServerAdminClient>

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

// Pesos-hipótese do gabarito (ADR-007 Revisão 1). Recalibrar só com N≥~50 desfechos.
// O score é somado AQUI (código), nunca pelo LLM — LLM não faz aritmética confiável.
export const PESOS_GABARITO: Record<string, number> = {
  conexao_inicial: 0.5,
  qualificacao: 1.0,
  diagnostico: 1.5,
  construcao_valor: 1.5,
  convite: 1.0,
  clareza: 1.0,
  continuidade: 1.5,
  fluencia: 0.5,
  confianca: 1.5,
  objecao_preco: 2.0,
}
const MAX_PONTOS = 2 * Object.values(PESOS_GABARITO).reduce((a, b) => a + b, 0) // 24

const SYSTEM_AUDITOR = `Você é o AUDITOR da Sara, a consultora de matrículas do Colégio Pequenos Guardiões.
Seu trabalho NÃO é atender famílias. É avaliar, de forma fria e consistente, uma conversa JÁ ENCERRADA entre a Sara e uma família, e prever se essa conversa levaria a um COMPARECIMENTO à visita (visita realizada, não só agendada) — o único desfecho que importa neste gabarito.

Você não elogia a Sara. Você é um juiz de evidências. Para cada critério, atribui um nível (0, 1 ou 2) e CITA o trecho da conversa que justifica. Sem citação, o nível é 0.

## Escala (idêntica para todos os critérios)
- 0 = Ausente: sem evidência do comportamento.
- 1 = Parcial: comportamento incompleto, tardio ou fraco.
- 2 = Pleno: comportamento claro e no momento certo.

## Os 10 critérios
1. conexao_inicial — Acolhimento/rapport ANTES de orientar ou vender.
2. qualificacao — Nome da criança E idade/série E turno pretendido identificados.
3. diagnostico — O MOTIVO REAL da busca (a dor/o gatilho de agora) foi compreendido.
4. construcao_valor — Diferenciais conectados à necessidade ESPECÍFICA da família (genérico = máx 1).
5. convite — Visita apresentada como próximo passo com proposta concreta (dia/horário).
6. clareza — A família sabe EXATAMENTE o que fazer a seguir.
7. continuidade — Existe próximo passo REGISTRADO (visita marcada, retorno com data).
8. fluencia — Sem fricção que esfria (sem gaps longos, sem repetir pergunta já respondida).
9. confianca — Evidência de AUMENTO de confiança (família compartilha mais, pergunta "para frente", sentimento positivo).
10. objecao_preco — Quando a família perguntou o valor, a Sara ancorou com "a partir de R$X" real e conectou a valor (Pleno) ou fez STONEWALL e desviou (Ausente). Se a família NÃO perguntou preço, nivel=2 e evidencia="família não perguntou preço".

## Você também produz
- probabilidade_holistica (0–100): sua estimativa direta da chance de COMPARECIMENTO.
- gap_dominante: o ÚNICO critério que, se fosse Pleno, mais aumentaria a chance de comparecimento.
- sugestao: correção acionável e específica para a Sara, baseada no gap_dominante. Uma frase, no imperativo.

## Etapa do funil (CRÍTICO — a sugestão serve ao OBJETIVO da etapa)
A conversa vem com a ETAPA ATUAL do lead e o OBJETIVO dessa etapa. Sua sugestão (campo "sugestao") e o gap_dominante devem servir a ESSE objetivo — nunca a uma fase que já passou.
- A "sugestao" é a próxima ação que mais aproxima o lead do objetivo da etapa atual (ex.: em No Show, reengajar e reagendar; em Visita Realizada, conduzir ao fechamento da matrícula).
- Um passo que já aconteceu na etapa (ex.: convite, para quem já agendou/visitou) recebe nível 2, não 0.
- Se o OBJETIVO indicar um gap_dominante específico (reagendamento, fechamento, confirmacao, reativacao, diagnostico_perda, nenhum), use EXATAMENTE esse valor — NÃO escolha um critério de pré-visita (objecao_preco, convite, etc.) como gap fora da fase de captação.

## Regras
- Cite sempre evidência real (trecho literal curto). Sem trecho, nível = 0.
- Não invente comportamento que não está no texto. Não some notas nem calcule score.
- Responda SOMENTE com JSON, no formato:
{"criterios":[{"id":1,"nome":"conexao_inicial","nivel":0,"evidencia":"","justificativa":""}, ... 10 itens ...],"probabilidade_holistica":0,"gap_dominante":"objecao_preco","sugestao":""}`

export type CriterioNivel = {
  id: number
  nome: string
  nivel: number
  evidencia?: string
  justificativa?: string
}
export type AuditorOut = {
  criterios: CriterioNivel[]
  probabilidade_holistica?: number
  gap_dominante?: string
  sugestao?: string
}

export function calcularScore(criterios: CriterioNivel[]): { score: number; faixa: string } {
  let soma = 0
  for (const c of criterios || []) {
    const peso = PESOS_GABARITO[c?.nome] ?? 0
    const nivel = typeof c?.nivel === 'number' ? Math.max(0, Math.min(2, c.nivel)) : 0
    soma += nivel * peso
  }
  const score = Math.round((100 * soma) / MAX_PONTOS)
  const faixa = score < 40 ? 'frio' : score < 70 ? 'morno' : 'quente'
  return { score, faixa }
}

/** Objetivo da etapa do funil — a correção sugerida deve servir a ele. */
export function objetivoDaEtapa(etapa: string): string {
  const e = (etapa || '').toLowerCase()
  if (/no\s*show/.test(e))
    return 'RECUPERAR e REAGENDAR: a família agendou e NÃO compareceu. Reengaje com empatia, descubra o que impediu e proponha nova data — sem cobrança. Defina gap_dominante="reagendamento". NUNCA sugira preço nesta etapa.'
  if (/visita\s*realizada/.test(e))
    return 'CONVERTER EM MATRÍCULA: a família JÁ VISITOU. Trate objeções finais e conduza ao fechamento. Defina gap_dominante="fechamento" e probabilidade_holistica=100 (já compareceu). NUNCA sugira preço nem convite.'
  if (/agendad/.test(e))
    return 'GARANTIR O COMPARECIMENTO: visita marcada. Confirme, gere expectativa e remova fricção. Defina gap_dominante="confirmacao". O convite já foi feito.'
  if (/repescag/.test(e))
    return 'REATIVAR: o lead esfriou. Reabordar gerando novo interesse e um motivo concreto para retomar. Defina gap_dominante="reativacao".'
  if (/perdid/.test(e))
    return 'APRENDER COM A PERDA (win-back se houver brecha). Defina gap_dominante="diagnostico_perda" e aponte o que causou a perda.'
  if (/matricul/.test(e)) return 'OBJETIVO CUMPRIDO (aluno): gap_dominante="nenhum", probabilidade_holistica=100.'
  return 'AGENDAR A VISITA: qualifique, construa valor, trate a objeção de preço e conduza ao agendamento. Escolha o gap_dominante entre os 10 critérios do gabarito normalmente.'
}

/** Audita UMA conversa (lead) e grava a sugestão em sugestoes_auditoria. */
export async function auditarConversa(
  supabase: Supa,
  leadId: string
): Promise<{ leadId: string; score?: number; faixa?: string; gap?: string; skip?: string; erro?: string }> {
  const { data: msgs } = await supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: true })

  if (!msgs || msgs.length === 0) return { leadId, skip: 'sem_mensagens' }

  const transcricao = msgs
    .map((m) => `${m.direcao === 'in' ? 'FAMILIA' : 'SARA'}: ${String(m.conteudo || '').replace(/\s+/g, ' ').slice(0, 500)}`)
    .join('\n')

  // Etapa atual do lead no funil — o auditor precisa sugerir conforme o momento.
  const { data: leadRow } = await supabase
    .from('leads')
    .select('coluna:colunas(nome)')
    .eq('id', leadId)
    .maybeSingle()
  const etapa = (leadRow as any)?.coluna?.nome || 'Em Atendimento'
  const objetivo = objetivoDaEtapa(etapa)

  const { data: config } = await supabase.from('config_ia').select('modelo').eq('id', 1).single()
  const modelo = config?.modelo?.startsWith('gpt') ? config.modelo : 'gpt-4o'

  const response = await getOpenAI().chat.completions.create({
    model: modelo,
    max_tokens: 1400,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_AUDITOR },
      {
        role: 'user',
        content: `ETAPA ATUAL DO LEAD: ${etapa}\nOBJETIVO DESTA ETAPA: ${objetivo}\n\nCONVERSA (ordem cronológica):\n${transcricao}\n\nAvalie segundo o gabarito e faça a "sugestao" servir ao OBJETIVO DESTA ETAPA. Responda apenas com o JSON.`,
      },
    ],
  })

  const parsed = JSON.parse(response.choices[0]?.message?.content || '{}') as AuditorOut
  const criterios = Array.isArray(parsed.criterios) ? parsed.criterios : []
  const { score, faixa } = calcularScore(criterios)
  const gap = parsed.gap_dominante || '—'
  const gapCrit = criterios.find((c) => c.nome === gap)

  await supabase.from('sugestoes_auditoria').insert({
    lead_id: leadId,
    conversa_ref: msgs[msgs.length - 1].criado_em,
    criterio: gap,
    diagnostico: gapCrit?.justificativa || `Gap dominante: ${gap}`,
    sugestao: parsed.sugestao || 'Sem sugestão gerada.',
    tipo: 'correcao_sara',
    hash_padrao: gap, // agrupa recorrências por critério para a promoção de Nível 2
    status: 'pendente',
    score_preditivo: score,
    faixa,
    probabilidade_holistica: typeof parsed.probabilidade_holistica === 'number' ? parsed.probabilidade_holistica : null,
    detalhe: parsed as unknown as object,
  })

  return { leadId, score, faixa, gap }
}

/**
 * Audita conversas de captação ainda não auditadas.
 * Filtra para o funil de captação (exclui Matriculados) e conversas reais (≥3 msgs da família),
 * evitando teste/lixo. Uma sugestão por conversa (não reprocessa) — v1.
 */
export async function auditarPendentes(
  supabase: Supa,
  limit = 20
): Promise<Array<{ leadId: string; score?: number; faixa?: string; gap?: string; skip?: string; erro?: string }>> {
  const { data: funil } = await supabase.from('funis').select('id').eq('is_padrao', true).maybeSingle()
  if (!funil) return []
  const { data: cols } = await supabase.from('colunas').select('id').eq('funil_id', funil.id)
  const colIds = (cols || []).map((c) => c.id)
  if (colIds.length === 0) return []

  const { data: leads } = await supabase
    .from('leads')
    .select('id')
    .in('coluna_id', colIds)
    .eq('arquivado', false)

  const resultados: Array<{ leadId: string; score?: number; faixa?: string; gap?: string; skip?: string; erro?: string }> = []

  for (const l of leads || []) {
    if (resultados.length >= limit) break

    // Já auditada? (v1: uma sugestão por conversa — evita reprocessar e gastar token)
    const { data: existe } = await supabase
      .from('sugestoes_auditoria')
      .select('id')
      .eq('lead_id', l.id)
      .limit(1)
      .maybeSingle()
    if (existe) continue

    // Conversa real de captação? ≥3 mensagens da família (exclui teste/lixo/1 toque)
    const { count } = await supabase
      .from('mensagens')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', l.id)
      .eq('direcao', 'in')
    if ((count || 0) < 3) continue

    try {
      resultados.push(await auditarConversa(supabase, l.id))
    } catch (e) {
      resultados.push({ leadId: l.id, erro: e instanceof Error ? e.message : 'erro desconhecido' })
    }
  }

  return resultados
}

/**
 * Guardrail do COO: mede se cada regra ativa moveu a taxa conversa→compareceu.
 * kpi_pos = taxa sobre conversas iniciadas DEPOIS que a regra ficou ativa.
 * Regra cujo kpi_pos < kpi_baseline (com amostra) é candidata a aposentadoria.
 */
export async function medirRegrasAtivas(supabase: Supa): Promise<number> {
  const { data: regras } = await supabase
    .from('regras_aprendidas')
    .select('id, criada_em')
    .eq('ativa', true)

  let medidas = 0
  for (const r of regras || []) {
    const { data: pos, error } = await supabase.rpc('taxa_comparecimento', { desde: r.criada_em, ate: null })
    if (error) continue
    await supabase.from('regras_aprendidas').update({ kpi_pos: pos }).eq('id', r.id)
    medidas++
  }
  return medidas
}
