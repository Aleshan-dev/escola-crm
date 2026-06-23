import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function gerarRespostaSara(leadId: string): Promise<string> {
  const supabase = createServerAdminClient()

  // Pega dados do lead
  const { data: lead } = await supabase
    .from('leads')
    .select('*, familia:familias(*), crianca:criancas(*)')
    .eq('id', leadId)
    .single()

  if (!lead) throw new Error('Lead não encontrado')

  // Configuração da Sara
  const { data: config } = await supabase.from('config_ia').select('*').eq('id', 1).single()

  // Base de conhecimento ativa
  const { data: kb } = await supabase
    .from('base_conhecimento')
    .select('categoria, pergunta, resposta')
    .eq('ativa', true)

  // Últimas 20 mensagens do lead
  const { data: msgs } = await supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(20)

  const historico = (msgs || []).reverse()

  const systemPrompt = `${config?.system_prompt || 'Você é Sara, consultora de matrículas do Colégio Pequenos Guardiões.'}

INFORMAÇÕES DA ESCOLA (use quando relevante):
${(kb || []).map((k) => `[${k.categoria}] ${k.pergunta}\nResposta: ${k.resposta}`).join('\n\n')}

DADOS QUE JÁ TEM SOBRE ESTA FAMÍLIA:
- Responsável: ${lead.familia?.nome_responsavel || 'não informado'}
- Telefone: ${lead.familia?.telefone}
- Criança: ${lead.crianca?.nome || 'não informado'}${lead.crianca?.idade ? `, ${lead.crianca.idade} anos` : ''}
- Período desejado: ${lead.crianca?.periodo || 'não informado'}
- Score atual: ${lead.score}

REGRAS:
- Não repita perguntas já respondidas no histórico
- Seja acolhedora, profissional e direta
- Sempre proponha um próximo passo concreto
- Mensagens curtas, no máximo 3 linhas
- Se a família demonstrar interesse forte, ofereça visita presencial`

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    ...historico.map((m) => ({
      role: (m.direcao === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.conteudo,
    })),
  ]

  const modelo = (config?.modelo && config.modelo.startsWith('gpt')) ? config.modelo : 'gpt-4o'

  const response = await openai.chat.completions.create({
    model: modelo,
    max_tokens: 500,
    messages,
  })

  return response.choices[0]?.message?.content || 'Desculpe, não consegui responder agora.'
}