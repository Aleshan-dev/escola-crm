import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'
import { calcularSlotsDisponiveis } from '@/lib/disponibilidade'
import { sincronizarGoogleParaDisponibilidade } from '@/lib/google-calendar'
import { getOcupacaoDireta } from '@/lib/sgei'

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

export type SaraAnalise = {
  intencao: string | null
  emocao: string | null
  temperatura: string | null
  interesse: number | null
  urgencia: number | null
  probabilidade: number | null
  proxima_acao: string | null
}

export type SaraResposta = {
  resposta: string
  proxima_coluna_id: string | null
  razao_movimentacao: string | null
  familia_dados: SaraFamiliaDados | null
  crianca_dados: SaraCriancaDados | null
  criancas_dados: SaraCriancaDados[] | null // irmãos: um item por criança
  transbordo: boolean
  motivo_transbordo: string | null
  agendar_visita: { data_hora: string } | null
  sugerir_matricula: boolean
  resumo_anotacao: string | null
  analise: SaraAnalise | null
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
    .select('*, familia:familias(*, criancas(*)), crianca:criancas(*)')
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

  const { data: anotacoes } = await supabase
    .from('anotacoes')
    .select('conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(10)

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
"Matriculados" NUNCA pode ser destino.
Se a família CONFIRMAR que vai matricular / que fechou / que já pagou a matrícula, NÃO mova para Matriculados. Em vez disso, preencha "sugerir_matricula": true (o gestor confirma manualmente). Em qualquer outro caso, "sugerir_matricula": false.`
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

  const listaAnotacoes = (anotacoes || [])
    .map((a) => {
      const d = a.criado_em ? new Date(a.criado_em).toLocaleDateString('pt-BR') : ''
      return `- (${d}) ${a.conteudo}`
    })
    .join('\n')
  const blocoAnotacoes = listaAnotacoes
    ? `
════════════════════════════════
ANOTAÇÕES INTERNAS DA EQUIPE SOBRE ESTE LEAD
(LEVE ESTAS ANOTAÇÕES EM CONTA ao decidir o que dizer e como abordar a família — elas têm prioridade sobre suposições. NUNCA repita o texto delas literalmente à família; use o conteúdo para personalizar sua mensagem.)
════════════════════════════════
${listaAnotacoes}`
    : ''

  // Antes de calcular a disponibilidade, puxa do Google (cache de 90s) para não
  // oferecer horário já ocupado direto no Google Agenda.
  await sincronizarGoogleParaDisponibilidade(supabase)
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
  const criancasFamilia =
    ((dadosFamilia as unknown as { criancas?: Array<{ nome?: string; idade?: number }> })?.criancas) || []

  // Data de hoje no fuso de Rio Branco/Acre (UTC-5) — para a Sara escrever datas absolutas.
  const hojeAcre = new Date(Date.now() - 5 * 60 * 60 * 1000).toLocaleDateString('pt-BR', { timeZone: 'UTC' })

  // Vagas por turma em tempo real (sistema acadêmico SGEI). Falha silenciosa:
  // se indisponível, a Sara segue sem o bloco (não quebra o atendimento).
  const ocupacao = await getOcupacaoDireta().catch(() => null)
  const blocoVagas =
    ocupacao && ocupacao.length
      ? `
════════════════════════════════
VAGAS POR TURMA — DADO REAL E ATUAL (fonte: sistema acadêmico)
════════════════════════════════
Ao falar de disponibilidade, use SOMENTE estes números. NUNCA ofereça turma sem vaga: se estiver lotada, diga que no momento está sem vagas e ofereça lista de espera ou uma turma próxima que tenha vaga.
${ocupacao.map((o) => `- ${o.turma}: ${o.vagas > 0 ? `${o.vagas} vaga(s) disponível(is)` : 'SEM vagas (turma lotada)'} — ${o.matriculados}/${o.capacidade} matriculados`).join('\n')}`
      : ''

  const systemPrompt = `${config?.system_prompt || 'Você é Sara, consultora de matrículas do Colégio Pequenos Guardiões.'}

Hoje é ${hojeAcre} (horário de Rio Branco/Acre).

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
${blocoVagas}

════════════════════════════════
DADOS JÁ COLETADOS DESTA FAMÍLIA
════════════════════════════════
- Responsável: ${dadosFamilia?.nome_responsavel || 'não informado'}
- Crianças da família: ${criancasFamilia.length ? criancasFamilia.map((c) => `${c.nome || 'a confirmar'}${c.idade ? ` (${c.idade}a)` : ''}`).join('; ') : (dadosCrianca?.nome || 'não informado')}
- Criança (principal): ${dadosCrianca?.nome || 'não informado'}
- Idade: ${dadosCrianca?.idade ? `${dadosCrianca.idade} anos` : 'não informado'}
- Série desejada: ${dadosCrianca?.serie_desejada || 'não informado'}
- Período desejado: ${dadosCrianca?.periodo || 'não informado'}

DADOS OBRIGATÓRIOS FALTANDO (colete um por vez):
${!dadosCrianca?.nome ? '- Nome da criança\n' : ''}${!dadosCrianca?.idade ? '- Idade da criança\n' : ''}${!dadosCrianca?.serie_desejada ? '- Série/turma desejada\n' : ''}${!dadosCrianca?.periodo ? '- Período desejado\n' : ''}

════════════════════════════════
CONDUTA OBRIGATÓRIA DO ATENDIMENTO
════════════════════════════════
1. PERSONALIZE sempre. Chame o responsável pelo primeiro nome ("${(dadosFamilia?.nome_responsavel || '').split(' ')[0] || 'responsável'}") e use nome/idade/série da criança já conhecidos. DEDUZA o gênero do responsável pelo primeiro nome e trate no gênero certo (nome feminino → "seja bem-vinda", "a senhora"; masculino → "seja bem-vindo", "o senhor"). Se o nome for ambíguo, use uma saudação neutra. NUNCA recomece a conversa do zero quando já há dados coletados — retome de onde parou. ATENÇÃO AO NOME DO RESPONSÁVEL: o nome mostrado pode ser só o nome do PERFIL do WhatsApp — muitas vezes um apelido ou o nome da própria CRIANÇA, não o nome do pai/mãe. NÃO assuma. Se o "nome do responsável" for igual (ou muito parecido) ao nome da criança, está errado: pergunte com quem você fala ("Como posso te chamar?") e grave o nome real em familia_dados.nome_responsavel. NUNCA chame o pai/mãe pelo nome da criança.
2. EXIJA OS DADOS OBRIGATÓRIOS antes de avançar o lead: nome da criança, idade, série/turma desejada e período. Peça UM de cada vez, de forma acolhedora, e NÃO avance de etapa enquanto faltar algum obrigatório.
3. VISITA — só sinalize movimentação para "Visita Agendada" DEPOIS de a família CONFIRMAR uma data/horário específico E você preencher "agendar_visita". NUNCA mova para "Visita Agendada" só porque a família demonstrou interesse em visitar; primeiro agende.
4. REAGENDAMENTO — se a família pedir para MUDAR a data/horário de uma visita já marcada, preencha "agendar_visita" com o NOVO horário. O sistema ATUALIZA a visita existente (não crie uma segunda). Confirme o novo horário com clareza.
5. IRMÃOS — se a família tiver MAIS DE UMA criança, pergunte e colete os dados (nome, idade, série, período) de CADA uma e devolva TODAS no campo "criancas_dados" (um item por criança). Não misture os dados de irmãos.
${instrucaoMovimentacao}
${promptAdicional ? `\nINSTRUÇÃO ESPECIAL: ${promptAdicional}` : ''}
${blocoAgenda}
${blocoAnotacoes}

════════════════════════════════
TRANSBORDO PARA HUMANO
════════════════════════════════
Marque transbordo=true se:
1. Família pediu para falar com atendente/humano/coordenação
2. Família fez reclamação grave
3. Você usou "vou verificar com a equipe" 2+ vezes seguidas
Gatilho automático: ${countVerificar >= 2 ? 'SIM — FORCE transbordo=true agora.' : 'não ativo'}

════════════════════════════════
ANOTAÇÃO INTERNA (resumo_anotacao)
════════════════════════════════
Preencha "resumo_anotacao" com 1-2 frases resumindo o que há de NOVO nesta conversa (dado coletado, visita marcada, objeção, decisão da família). Se não houver fato novo relevante, use null.
- Escreva SEMPRE com DATAS ABSOLUTAS (ex.: "visita em 30/06/2026"). NUNCA use termos relativos como "hoje", "amanhã", "semana que vem" — converta usando a data de hoje informada acima.
- É um registro interno para a equipe; seja objetiva.

════════════════════════════════
ANÁLISE COGNITIVA INTERNA (campo "analise")
════════════════════════════════
Preencha "analise" com sua leitura interna do lead: intenção (ex.: pedido de preço, troca de escola), emoção predominante (ex.: medo, insegurança, pressa, confiança), temperatura ("frio", "morno", "quente" ou "pronto_visita"), e um score de 1 a 5 para interesse, urgencia e probabilidade de matrícula, além da próxima melhor ação. É CONTEXTO INTERNO do CRM — NUNCA apareça para a família nem no campo "resposta".

════════════════════════════════
FORMATO JSON OBRIGATÓRIO (sem markdown, sem texto fora do JSON)
════════════════════════════════
{
  "resposta": "texto para a família",
  "proxima_coluna_id": "uuid ou null",
  "razao_movimentacao": "texto ou null",
  "familia_dados": { "nome_responsavel": "...", "email": "..." } ou null,
  "crianca_dados": { "nome": "...", "idade": 3, "serie_desejada": "G3", "periodo": "Integral" } ou null,
  "criancas_dados": [ { "nome": "...", "idade": 3, "serie_desejada": "G3", "periodo": "Integral" } ] ou null,
  "transbordo": false,
  "motivo_transbordo": "texto ou null",
  "agendar_visita": { "data_hora": "2026-07-02T14:00:00.000Z" } ou null,
  "sugerir_matricula": false,
  "resumo_anotacao": "1-2 frases com datas absolutas ou null",
  "analise": { "intencao": "texto", "emocao": "texto", "temperatura": "frio|morno|quente|pronto_visita", "interesse": 3, "urgencia": 3, "probabilidade": 3, "proxima_acao": "texto" }
}`

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    ...historico.map((m) => ({
      role: (m.direcao === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.conteudo,
    })),
  ]

  // Follow-up: o histórico termina numa fala da própria Sara, então sem um turno
  // final o modelo tende a repetir a última mensagem. Este turno força uma mensagem
  // NOVA, personalizada com base em toda a conversa acima.
  if (promptAdicional) {
    messages.push({
      role: 'user',
      content: `[INSTRUÇÃO INTERNA DO SISTEMA — não é uma mensagem da família; não a repita]
${promptAdicional}
Escreva AGORA uma mensagem de follow-up NOVA e curta, levando em conta tudo o que já foi conversado acima nesta conversa específica (nome da criança, série/período, valores e pendências já tratados, e o que a família disse por último) E TAMBÉM as ANOTAÇÕES INTERNAS DA EQUIPE sobre este lead (se houver). Retome de onde a conversa parou, seja pessoal e específica. NÃO repita nem reformule mensagens que você já enviou antes. Responda no formato JSON obrigatório.`,
    })
  }

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
      criancas_dados: Array.isArray(parsed.criancas_dados) ? parsed.criancas_dados : null,
      transbordo: parsed.transbordo === true,
      motivo_transbordo: parsed.motivo_transbordo ?? null,
      agendar_visita:
        parsed.agendar_visita && parsed.agendar_visita.data_hora
          ? { data_hora: parsed.agendar_visita.data_hora }
          : null,
      sugerir_matricula: parsed.sugerir_matricula === true,
      resumo_anotacao: parsed.resumo_anotacao ?? null,
      analise: parsed.analise
        ? {
            intencao: parsed.analise.intencao ?? null,
            emocao: parsed.analise.emocao ?? null,
            temperatura: parsed.analise.temperatura ?? null,
            interesse: typeof parsed.analise.interesse === 'number' ? parsed.analise.interesse : null,
            urgencia: typeof parsed.analise.urgencia === 'number' ? parsed.analise.urgencia : null,
            probabilidade: typeof parsed.analise.probabilidade === 'number' ? parsed.analise.probabilidade : null,
            proxima_acao: parsed.analise.proxima_acao ?? null,
          }
        : null,
    }
  } catch {
    return {
      resposta: raw || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: null,
      razao_movimentacao: null,
      familia_dados: null,
      crianca_dados: null,
      criancas_dados: null,
      transbordo: false,
      motivo_transbordo: null,
      agendar_visita: null,
      sugerir_matricula: false,
      resumo_anotacao: null,
      analise: null,
    }
  }
}
