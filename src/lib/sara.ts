import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'

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

export type SaraResposta = {
  resposta: string
  proxima_coluna_id: string | null
  razao_movimentacao: string | null
  resumo_anotacao: string | null
}

export async function gerarRespostaSara(
  leadId: string,
  colunas?: SaraColuna[],
  colunaAtual?: SaraColuna,
  promptAdicional?: string
): Promise<SaraResposta> {
  const supabase = createServerAdminClient()

  const { data: lead }: { data: any } = await supabase
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

  const { data: msgs } = await supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(20)

  const historico = (msgs || []).reverse()

  const instrucaoMovimentacao =
    colunas && colunaAtual
      ? `
MOVIMENTAÇÃO DE FUNIL:
Você pode sugerir mover este lead para a próxima etapa respondendo "proxima_coluna_id".
Coluna atual: "${colunaAtual.nome}" (ordem ${colunaAtual.ordem})
Colunas disponíveis para avanço:
${colunas
  .filter((c) => c.ordem > colunaAtual.ordem)
  .map((c) => `- id="${c.id}" nome="${c.nome}" ordem=${c.ordem}`)
  .join('\n')}

Critérios para avançar coluna (SÓ avance uma etapa por vez, ordem atual + 1):
- Capturados → Em Atendimento: família demonstrou interesse genuíno e está fazendo perguntas concretas
- Em Atendimento → Visita Agendada: combinamos visita com data e horário confirmados
- Visita Agendada → Visita Realizada: família confirmou que a visita aconteceu
- Visita Realizada → Repescagem: família demonstrou dúvida ou pediu prazo
- Qualquer → Perdidos: família disse que não vai matricular (razao_movimentacao é OBRIGATÓRIA)

IMPORTANTE: "Matriculados" requer confirmação humana, NUNCA mova para lá.
Se não houver motivo claro, retorne proxima_coluna_id como null.`
      : ''

  const systemPrompt = `${config?.system_prompt || 'Você é Sara, consultora de matrículas do Colégio Pequenos Guardiões, escola cristã de educação infantil em Fronteiras-PI.'}

INFORMAÇÕES DA ESCOLA (use quando relevante):
${(kb || []).map((k) => `[${k.categoria}] ${k.pergunta}\nResposta: ${k.resposta}`).join('\n\n')}

DADOS QUE JÁ TEM SOBRE ESTA FAMÍLIA:
- Responsável: ${lead.familia?.nome_responsavel || 'não informado'}
- Telefone: ${lead.familia?.telefone}
- Criança: ${lead.crianca?.nome || 'não informado'}${lead.crianca?.idade ? `, ${lead.crianca.idade} anos` : ''}
- Série desejada: ${lead.crianca?.serie_desejada || 'não informado'}
- Período desejado: ${lead.crianca?.periodo || 'não informado'}
- Score atual: ${lead.score}
${instrucaoMovimentacao}
${promptAdicional ? `\nINSTRUÇÃO ESPECIAL: ${promptAdicional}` : ''}

REGRAS:
- Não repita perguntas já respondidas no histórico
- Seja acolhedora, profissional e direta
- Sempre proponha um próximo passo concreto
- Mensagens curtas, no máximo 3 linhas
- Se a família demonstrar interesse forte, ofereça visita presencial

FORMATO DE RESPOSTA OBRIGATÓRIO — responda SOMENTE com JSON válido, sem markdown, sem explicações:
{
  "resposta": "texto da mensagem para a família",
  "proxima_coluna_id": "uuid da próxima coluna OU null",
  "razao_movimentacao": "explicação breve OU null",
  "resumo_anotacao": "1-2 frases resumindo o que ha de novo na conversa (dados coletados, visita agendada, objecao, decisao) OU null se nao houver fato novo relevante"
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
    max_tokens: 600,
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
      resumo_anotacao: parsed.resumo_anotacao ?? null,
    }
  } catch {
    return {
      resposta: raw || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: null,
      razao_movimentacao: null,
      resumo_anotacao: null,
    }
  }
}
