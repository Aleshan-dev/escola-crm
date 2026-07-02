import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'
import { calcularSlotsDisponiveis } from '@/lib/disponibilidade'

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

export type SaraColuna = {
  id: string
  nome: string
  ordem: number
}

export type SaraFamiliaDados = {
  nome_responsavel?: string
  email?: string
  cep?: string
  rua?: string
  numero?: string
  bairro?: string
  cidade?: string
  estado?: string
}

export type SaraCriancaDados = {
  nome?: string
  idade?: number
  data_nascimento?: string
  serie_desejada?: string
  periodo?: string
}

export type SaraResposta = {
  resposta: string
  proxima_coluna_id: string | null
  razao_movimentacao: string | null
  familia_dados: SaraFamiliaDados | null
  crianca_dados: SaraCriancaDados | null
  transbordo: boolean
  motivo_transbordo: string | null
  agendar_visita: { data_hora: string } | null
}

export async function gerarRespostaSara(
  leadId: string,
  colunas?: SaraColuna[],
  colunaAtual?: SaraColuna,
  promptAdicional?: string
): Promise<SaraResposta> {
  const supabase = createServerAdminClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('*, familia:familias(*), crianca:criancas(*)')
    .eq('id', leadId)
    .single()

  if (!lead) throw new Error('Lead não encontrado')

  const { data: config } = await supabase.from('config_ia').select('*').eq('id', 1).single()
  const { data: kb } = await supabase
    .from('base_conhecimento')
    .select('categoria, pergunta, resposta')
    .eq('ativa', true)

  const { data: series } = await supabase
    .from('series')
    .select('nome, faixa_etaria')
    .eq('ativa', true)
    .order('ordem')

  const { data: turnos } = await supabase
    .from('turnos')
    .select('nome, hora_inicio, hora_fim')
    .eq('ativo', true)
    .order('ordem')

  const { data: msgs } = await supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(20)

  const historico = (msgs || []).reverse()

  const ultimasMsgsIA = historico
    .filter((m) => m.direcao === 'out_ia')
    .slice(-3)
    .map((m) => m.conteudo.toLowerCase())
  const countVerificar = ultimasMsgsIA.filter(
    (t) => t.includes('vou verificar') || t.includes('vou checar') || t.includes('equipe')
  ).length

  const instrucaoMovimentacao =
    colunas && colunaAtual
      ? `
MOVIMENTAÇÃO DE FUNIL:
Coluna atual: "${colunaAtual.nome}" (ordem ${colunaAtual.ordem})
Próximas opções:
${colunas
  .filter((c) => c.ordem > colunaAtual.ordem)
  .map((c) => `- id="${c.id}" nome="${c.nome}" ordem=${c.ordem}`)
  .join('\n')}
Critérios (só avance UMA etapa, ordem atual+1):
- Capturados→Em Atendimento: família fez pergunta concreta ou demonstrou interesse real
- Em Atendimento→Visita Agendada: visita confirmada com data/hora
- Visita Agendada→Visita Realizada: família confirmou que a visita ocorreu
- Visita Realizada→Repescagem: família pediu prazo ou demonstrou dúvida
- Qualquer→Perdidos: família recusou explicitamente (razao_movimentacao obrigatória)
"Matriculados" NUNCA pode ser destino.`
      : ''

  const baseKnowledge = (kb || [])
    .map((k) => `[${k.categoria}] P: ${k.pergunta}\nR: ${k.resposta}`)
    .join('\n\n')

  const listaSeries = (series || [])
    .map((s) => `- ${s.nome}${s.faixa_etaria ? ` (${s.faixa_etaria})` : ''}`)
    .join('\n')
  const listaTurnos = (turnos || [])
    .map((t) => {
      const ini = t.hora_inicio ? String(t.hora_inicio).slice(0, 5) : ''
      const fim = t.hora_fim ? String(t.hora_fim).slice(0, 5) : ''
      const faixa = ini || fim ? ` (${ini}–${fim})` : ''
      return `- ${t.nome}${faixa}`
    })
    .join('\n')

  const blocoConfig = `
════════════════════════════════
TURMAS E TURNOS OFICIAIS (fonte da verdade — use SOMENTE estes, nunca invente)
════════════════════════════════
TURMAS/SÉRIES disponíveis:
${listaSeries || '- (nenhuma turma configurada)'}
TURNOS/PERÍODOS disponíveis:
${listaTurnos || '- (nenhum turno configurado)'}
- Use a IDADE da criança para indicar a turma correta pela faixa etária acima.
- Em "crianca_dados.serie_desejada" preencha com o NOME EXATO de uma turma da lista.
- Em "crianca_dados.periodo" preencha com o NOME EXATO de um turno da lista.
- Se a idade não se encaixar em nenhuma turma, diga que vai confirmar com a equipe (não invente turma).`

  // Horários de visita realmente livres (cruza horarios_visita x tarefas/Google)
  const slots = await calcularSlotsDisponiveis(supabase, { quantidade: 2 })
  const blocoAgenda =
    slots.length > 0
      ? `
════════════════════════════════
AGENDAMENTO DE VISITA — HORÁRIOS REAIS DISPONÍVEIS
════════════════════════════════
Quando a família quiser visitar, ofereça SEMPRE e SOMENTE estas duas opções (NUNCA invente outros horários):
${slots.map((s, i) => `Opção ${i + 1}: ${s.label}  [data_hora=${s.data_hora}]`).join('\n')}
- Ao apresentar, use apenas o texto amigável (ex.: "${slots[0].label}"), sem mostrar o campo data_hora.
- Quando a família ESCOLHER/CONFIRMAR uma das opções, preencha "agendar_visita" com o data_hora EXATO (ISO) da opção escolhida e confirme a visita com alegria.
- Se nenhuma das duas servir, diga que vai verificar outras datas com a equipe (não invente horários).`
      : `
════════════════════════════════
AGENDAMENTO DE VISITA
════════════════════════════════
Não há horários de visita disponíveis no momento. Se a família quiser agendar, diga que vai confirmar as datas com a equipe (não invente horários).`

  const dadosFamilia = lead.familia
  const dadosCrianca = lead.crianca

  const systemPrompt = `${config?.system_prompt || 'Você é Sara, consultora de matrículas do Colégio Pequenos Guardiões.'}

════════════════════════════════
BASE DE CONHECIMENTO OFICIAL DA ESCOLA
(USE APENAS ESTAS INFORMAÇÕES. NUNCA INVENTE DADOS NÃO LISTADOS ABAIXO.)
════════════════════════════════
${baseKnowledge}

════════════════════════════════
REGRA ANTI-ALUCINAÇÃO — CRÍTICA
════════════════════════════════
- Se a pergunta NÃO puder ser respondida com os dados acima: diga "Vou verificar essa informação com a equipe e te retorno em breve! 😊"
- NUNCA invente endereço, telefone, valor, nome de professora ou qualquer dado não listado.
- O endereço correto é: Rua Avestruz, nº 271, Bairro Nova Esperança, Rio Branco – Acre.
${blocoConfig}

════════════════════════════════
DADOS JÁ COLETADOS DESTA FAMÍLIA
════════════════════════════════
- Responsável: ${dadosFamilia?.nome_responsavel || 'não informado'}
- Criança: ${dadosCrianca?.nome || 'não informado'}
- Idade: ${dadosCrianca?.idade ? `${dadosCrianca.idade} anos` : 'não informado'}
- Série desejada: ${dadosCrianca?.serie_desejada || 'não informado'}
- Período desejado: ${dadosCrianca?.periodo || 'não informado'}

DADOS OBRIGATÓRIOS FALTANDO (colete um por vez):
${!dadosCrianca?.nome ? '- Nome da criança\n' : ''}${!dadosCrianca?.idade ? '- Idade da criança\n' : ''}${!dadosCrianca?.serie_desejada ? '- Série/turma desejada\n' : ''}${!dadosCrianca?.periodo ? '- Período desejado\n' : ''}
${instrucaoMovimentacao}
${promptAdicional ? `\nINSTRUÇÃO ESPECIAL: ${promptAdicional}` : ''}
${blocoAgenda}

════════════════════════════════
TRANSBORDO PARA HUMANO
════════════════════════════════
Marque transbordo=true se:
1. Família pediu para falar com atendente/humano/coordenação
2. Família fez reclamação grave
3. Você usou "vou verificar com a equipe" 2+ vezes seguidas
Gatilho automático: ${countVerificar >= 2 ? 'SIM — FORCE transbordo=true agora.' : 'não ativo'}

════════════════════════════════
FORMATO JSON OBRIGATÓRIO (sem markdown, sem texto fora do JSON)
════════════════════════════════
{
  "resposta": "texto para a família",
  "proxima_coluna_id": "uuid ou null",
  "razao_movimentacao": "texto ou null",
  "familia_dados": { "nome_responsavel": "...", "email": "..." } ou null,
  "crianca_dados": { "nome": "...", "idade": 3, "serie_desejada": "G3", "periodo": "Integral" } ou null,
  "transbordo": false,
  "motivo_transbordo": "texto ou null",
  "agendar_visita": { "data_hora": "2026-07-02T14:00:00.000Z" } ou null
}`

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    ...historico.map((m) => ({
      role: (m.direcao === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.conteudo,
    })),
  ]

  const modelo = config?.modelo?.startsWith('gpt') ? config.modelo : 'gpt-4o'

  const response = await getOpenAI().chat.completions.create({
    model: modelo,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages,
  })

  const raw = response.choices[0]?.message?.content || '{}'

  try {
    const parsed = JSON.parse(raw) as Partial<SaraResposta>
    return {
      resposta: parsed.resposta || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: parsed.proxima_coluna_id ?? null,
      razao_movimentacao: parsed.razao_movimentacao ?? null,
      familia_dados: parsed.familia_dados ?? null,
      crianca_dados: parsed.crianca_dados ?? null,
      transbordo: parsed.transbordo === true,
      motivo_transbordo: parsed.motivo_transbordo ?? null,
      agendar_visita:
        parsed.agendar_visita && parsed.agendar_visita.data_hora
          ? { data_hora: parsed.agendar_visita.data_hora }
          : null,
    }
  } catch {
    return {
      resposta: raw || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: null,
      razao_movimentacao: null,
      familia_dados: null,
      crianca_dados: null,
      transbordo: false,
      motivo_transbordo: null,
      agendar_visita: null,
    }
  }
}
