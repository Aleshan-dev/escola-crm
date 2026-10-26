import { createServerAdminClient } from '@/lib/supabase-server'
import { calcularSlotsDisponiveis } from '@/lib/disponibilidade'
import { getOcupacaoDireta } from '@/lib/sgei'
import { formatarIdade } from '@/lib/idade'
import { resolverDiretrizes } from '@/lib/maestro/diretrizes'
import { chamarModeloIA } from '@/lib/ia-credenciais'
import { REGRA_ABRIR_CASO, blocoCasoAberto, type EstadoCaso } from '@/lib/casos/regras'
import { CAMPO_JSON_MEMORIA, ORCAMENTO_PADRAO, blocoMemoria, parseMemoriaSalvar, type PedidoMemoria } from '@/lib/memoria/regras'
import { carregarMemoria } from '@/lib/memoria/servico'

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
  // O modelo às vezes devolve texto ("2 anos"); dados-lead.ts normaliza antes de gravar.
  idade?: number | string
  idade_meses?: number | string
  data_nascimento?: string
  serie_desejada?: string
  periodo?: string
  motivo_busca?: string
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
  transbordo: boolean
  motivo_transbordo: string | null
  agendar_visita: { data_hora: string } | null
  sugerir_matricula: boolean
  // A Sara SUGERE encerrar o atendimento (conversa parece concluída). NUNCA silencia
  // sozinha: só levanta a bandeira para o gestor confirmar no botão. Ver atendimento.ts.
  sugerir_encerramento: boolean
  motivo_encerramento: string | null
  resumo_anotacao: string | null
  analise: SaraAnalise | null
  arquivar: boolean
  motivo_arquivamento: string | null
  // CASOS (src/lib/casos): pedido de retaguarda para a equipe e a informação que a
  // família deu quando a equipe pediu. Só vêm preenchidos com config_ia.casos_ativo.
  abrir_caso: unknown
  atualizar_caso: { informacao: string } | null
  // MEMÓRIA (src/lib/memoria): fatos duráveis a gravar, já com `substitui` em uuid.
  // Só o atendimento real grava (atendimento.ts / api/sara/responder); preview e
  // teste de rascunho apenas leem.
  memoria_salvar: PedidoMemoria[]
}

/** Turno extra no fim do histórico (retorno de Caso, reforço da guarda de promessa). */
export type ExtrasSara = { turnoFinal?: string }

// AUDITORIA CMO 2026-07-29 — saneamento da saída da Sara.
// Motivo: o corpus de 402 mensagens mostrou travessão copiado literalmente dos
// exemplos do prompt (7,7% das mensagens), placeholders de template vazados para
// a família ("[nome da criança]") e campos gravados com texto de espera
// ("A confirmar", "...") que passam por dado preenchido no CRM.
// O prompt já proíbe os três; isto é a rede de segurança em código.

/** Remove travessão e placeholders que escapem do prompt. */
export function limparTexto(texto?: string | null): string {
  if (!texto) return ''
  // Atenção: os regex abaixo NÃO podem usar \s, senão engolem a linha em branco
  // que separa os balões do WhatsApp. Só espaço e tab.
  return texto
    // travessão longo/médio vira vírgula (mantém a cadência da frase)
    .replace(/[ \t]*[—–][ \t]*/g, ', ')
    // placeholder de template não substituído pelo modelo
    .replace(/\[[^\]]*\]/g, '')
    // sobras de pontuação após as substituições acima
    .replace(/,[ \t]*,/g, ',')
    .replace(/[ \t]+([,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    // vírgula órfã no fim de um balão
    .replace(/,[ \t]*$/gm, '')
    .trim()
}

/** Valores que o modelo usa como "ainda não sei" e que NÃO podem virar dado. */
const VALORES_LIXO = new Set([
  'a confirmar', 'a definir', 'não informado', 'nao informado', 'não sei',
  'nao sei', 'desconhecido', 'n/a', 'na', 'null', 'undefined', 'criança',
  'crianca', 'filho', 'filha', 'sem nome', '-', '--', '...', '.', '?', '',
])

function ehLixo(valor: unknown): boolean {
  if (typeof valor !== 'string') return false
  const v = valor.trim().toLowerCase().replace(/\s+/g, ' ')
  if (VALORES_LIXO.has(v)) return true
  // string sem nenhuma letra (só pontuação, emoji ou número solto)
  return !/\p{L}/u.test(v)
}

/**
 * Descarta campos-lixo. Campo vazio é honesto: o gestor vê que falta.
 * "A confirmar" é pior que vazio, porque passa por preenchido.
 */
function limparDados<T extends object>(dados?: T | null): T | null {
  if (!dados) return null
  const limpo = Object.fromEntries(
    Object.entries(dados).filter(([, v]) => v !== null && v !== undefined && !ehLixo(v))
  ) as T
  return Object.keys(limpo).length > 0 ? limpo : null
}

export async function gerarRespostaSara(
  leadId: string,
  colunas?: SaraColuna[],
  colunaAtual?: SaraColuna,
  promptAdicional?: string,
  /** Teste de rascunho (versionamento): campos de config_ia que sobrepõem os do banco. Nunca usado em produção. */
  configOverride?: Record<string, unknown> | null,
  extras?: ExtrasSara
): Promise<SaraResposta> {
  const supabase = createServerAdminClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('*, familia:familias(*), crianca:criancas(*)')
    .eq('id', leadId)
    .single()

  if (!lead) throw new Error('Lead não encontrado')

  const { data: configBanco } = await supabase.from('config_ia').select('*').eq('id', 1).single()
  const config = configOverride ? { ...(configBanco ?? {}), ...configOverride } : configBanco
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

  // ADR-006 Nível 2: regras aprendidas e validadas pela supervisão (Auditor).
  // A Sara passa a ser: base + KB + REGRAS ATIVAS. Reversível (ativa=false).
  const { data: regrasAprendidas } = await supabase
    .from('regras_aprendidas')
    .select('texto_regra')
    .eq('ativa', true)
    .order('criada_em', { ascending: true })

  const historico = (msgs || []).reverse()

  // CASOS: com a função ligada, a Sara abre um Caso em vez de só prometer, e vê o
  // Caso aberto deste lead (se houver). Ver src/lib/casos/regras.ts.
  const casosAtivo = config?.casos_ativo === true
  const { data: casoAberto } = casosAtivo
    ? await supabase
        .from('casos')
        .select('numero, titulo, estado, nota_equipe')
        .eq('lead_id', leadId)
        .in('estado', ['aguardando_equipe', 'aguardando_familia'])
        .maybeSingle()
    : { data: null }

  // MEMÓRIA: fatos duráveis de conversas anteriores (além da janela de 20).
  const memoriaAtiva = config?.memoria_ativa !== false
  const memoria = memoriaAtiva ? await carregarMemoria(supabase, leadId) : { notas: [], mapa: {} }

  const ultimasMsgsIA = historico
    .filter((m) => m.direcao === 'out_ia')
    .slice(-3)
    .map((m) => m.conteudo.toLowerCase())
  // Com um Caso aberto, "vou verificar" é verdade (a equipe está mesmo
  // verificando): não conta para o transbordo forçado, senão o Caso vira handoff.
  const countVerificar = casoAberto
    ? 0
    : ultimasMsgsIA.filter(
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
- Em Atendimento→Visita Agendada: SÓ quando a família escolheu UMA data e horário CONCRETOS que você ofereceu e você preencheu "agendar_visita" neste mesmo turno. Interesse geral em visitar ("podemos sim", "quero conhecer"), pedido de prazo ("daqui a 3 semanas", "mês que vem"), condição futura ("quando ele chegar", "quando pegar folga") ou "depois eu marco/te aviso" NÃO são agendamento — mantenha o lead em Em Atendimento e NÃO preencha agendar_visita.
- Visita Realizada→Repescagem: família pediu prazo ou demonstrou dúvida
- Qualquer→Perdidos: família recusou explicitamente (razao_movimentacao obrigatória)
"Matriculados" e "Visita Realizada" NUNCA podem ser destino: ambos exigem confirmação humana. Você NÃO tem como saber se a família compareceu de fato à visita, então NUNCA mova para "Visita Realizada" — quem marca isso é o gestor, manualmente. Se a família disser que gostou ou que vai pensar, mantenha o lead onde está e siga a conversa.
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

  const listaRegras = (regrasAprendidas || []).map((r) => `- ${r.texto_regra}`).join('\n')
  const blocoRegras = listaRegras
    ? `
════════════════════════════════
REGRAS APRENDIDAS (validadas pela supervisão — SIGA-AS)
Padrões que comprovadamente melhoram o atendimento. Aplique-os naturalmente na conversa.
════════════════════════════════
${listaRegras}`
    : ''

  // Horários de visita realmente livres (cruza horarios_visita x tarefas/Google)
  //
  // ANTECEDÊNCIA MÍNIMA = 120 (2h) — decisão do gestor em 2026-09-16, após o caso
  // da Bruna: ela pediu visita para HOJE à tarde e, com o antigo 720 (12h), nenhum
  // horário de hoje passava no filtro; sem slot de hoje, a Sara acabou rotulando
  // amanhã como "hoje". Com 2h o mesmo-dia volta a ser ofertável.
  // (Histórico: o 720 veio da conversa da Gislainy, 29/07, para evitar oferta com
  // só 2h de aviso. `maxPorDia:1` segue espalhando as 2 opções em DIAS diferentes,
  // então um "nesse dia não dá" não derruba as duas.)
  const slots = await calcularSlotsDisponiveis(supabase, {
    quantidade: 2,
    antecedenciaMin: 120,
    maxPorDia: 1,
  })

  // AJUSTE 2026-08-13 (feedback do gestor): quando a família dizia que não podia
  // nos 2 horários ofertados, a Sara caía em "vou verificar com a equipe" — o que
  // tripava o gatilho de transbordo (2x "equipe") e jogava o lead para o humano,
  // em vez de PERGUNTAR qual horário serve e tentar encaixar. Para encaixar de
  // verdade, a Sara precisa ENXERGAR mais do que 2 slots. `slotsAmplos` é a agenda
  // real ampla (vários dias/horários livres) que ela usa SÓ para casar com um
  // pedido específico da família — nunca para despejar tudo de uma vez.
  const slotsAmplos = await calcularSlotsDisponiveis(supabase, {
    quantidade: 12,
    antecedenciaMin: 120,
    horizonteDias: 21,
  })

  // Grade semanal de visitas (dias/horários em que a escola RECEBE visita), para a
  // Sara saber o que é encaixável: se a família pede um dia sem janela de visita,
  // ela diz que naquele dia não há visita e oferece o dia de visita mais próximo.
  const { data: gradeVisita } = await supabase
    .from('horarios_visita')
    .select('dia_semana, hora_inicio, hora_fim')
    .eq('ativo', true)
  const listaGrade = (gradeVisita || [])
    .map((h) => {
      const ini = h.hora_inicio ? String(h.hora_inicio).slice(0, 5) : ''
      const fim = h.hora_fim ? String(h.hora_fim).slice(0, 5) : ''
      return `- ${h.dia_semana}: ${ini}–${fim}`
    })
    .join('\n')

  // GATE DE DESCOBERTA (2026-08-15): a visita só é liberada quando nome, idade E o
  // motivo real da busca (a "dor") estão capturados. Enquanto motivo_busca estiver
  // vazio, o prompt NÃO recebe horários — o modelo fica IMPOSSIBILITADO de empurrar
  // visita cedo, sem depender de "obedecer" a uma instrução de texto. Foi a lição da
  // conversa da Isabela (14/08): o prompt mandava descobrir a dor e o gpt-4o ignorou.
  const cr = lead.crianca
  const descobertaFeita = !!(
    cr?.nome && !ehLixo(cr.nome) &&
    (cr?.idade != null || cr?.idade_meses != null) &&
    cr?.motivo_busca && !ehLixo(cr.motivo_busca)
  )

  const blocoAgenda = !descobertaFeita
    ? `
════════════════════════════════
AGENDAMENTO DE VISITA — BLOQUEADO (descoberta incompleta)
════════════════════════════════
Você AINDA NÃO pode oferecer visita nem citar horários a esta família. Falta preencher a descoberta — veja exatamente o que falta em "DADOS OBRIGATÓRIOS FALTANDO", na seção de dados desta família. Descubra e registre, UMA pergunta por vez (se a família perguntou algo, responda primeiro e pergunte depois):
- nome da criança;
- idade da criança: registre SEMPRE que ela for dita, em anos ("2 anos") OU em meses ("9 meses", "1 ano e meio"), gravando em "crianca_dados.idade" e/ou "crianca_dados.idade_meses" (SEMPRE números inteiros, nunca texto: "3 anos e 5 meses" = idade 3, idade_meses 5). NUNCA deixe a idade só no texto: se você já usou a idade para inferir a turma (ex.: Berçário), então ela FOI dita e PRECISA estar gravada nesse campo.
- o MOTIVO REAL da busca, a "dor": por que procura escola agora e, se a criança já estuda em outra, o que gostaria de encontrar de diferente (nunca critique a escola atual). Grave em "crianca_dados.motivo_busca", uma frase curta com as palavras da família.
Assim que o que falta estiver preenchido, o sistema libera os horários no próximo turno.
PROIBIDO AGORA: oferecer visita, citar dia ou horário, dizer "posso te receber".
SE A FAMÍLIA PEDIR PARA AGENDAR e ainda faltar um dado: NUNCA recuse secamente, e JAMAIS diga "não podemos agendar" ou "falta confirmar alguns dados". Acolha com alegria, diga que já vai separar o melhor horário e peça de leve APENAS o primeiro item de "DADOS OBRIGATÓRIOS FALTANDO", no tom "que ótimo! só me confirma [o dado que falta] e já organizo tudo 😊". Se o que falta for só a idade e ela já apareceu na conversa, apenas confirme ("é isso mesmo, ele está com X meses?") em vez de perguntar do zero.`
    : slots.length > 0
      ? `
════════════════════════════════
AGENDAMENTO DE VISITA — HORÁRIOS REAIS DISPONÍVEIS
════════════════════════════════
A descoberta está completa (nome, idade e motivo capturados): você JÁ PODE oferecer a visita. Primeiro ESPELHE a dor da família com as palavras dela e ligue a visita a essa dor ("o que resolve essa insegurança é você ver a turma dele funcionando"), e só então ofereça os horários.

OFERTA PADRÃO — ofereça primeiro SEMPRE e SOMENTE estas duas opções (NUNCA invente horários):
${slots.map((s, i) => `Opção ${i + 1}: ${s.label}  [data_hora=${s.data_hora}]`).join('\n')}
- Ao apresentar, use apenas o texto amigável (ex.: "${slots[0].label}"), sem mostrar o campo data_hora. Termine com pergunta fechada ("qual encaixa melhor?").
- Quando a família ESCOLHER/CONFIRMAR uma opção, preencha "agendar_visita" com o data_hora EXATO (ISO) da opção escolhida e confirme a visita com alegria.
- O QUE NÃO É CONFIRMAÇÃO (nestes casos NUNCA preencha "agendar_visita" nem mova para Visita Agendada): interesse geral ("podemos sim", "quero conhecer"), pedido de prazo ("daqui a 3 semanas", "mês que vem"), condição futura ("quando ele chegar em Rio Branco", "quando conseguir folga") ou promessa de voltar ("depois eu marco", "te aviso"). Aí acolha, deixe a porta aberta e siga a conversa — o lead PERMANECE onde está. Só há agendamento quando ela crava UMA das opções (dia + hora).

SE A FAMÍLIA DISSER QUE NÃO PODE NESSES DOIS HORÁRIOS (regra dura — leia com atenção):
1. NÃO transfira para humano e NÃO diga "vou verificar com a equipe". PERGUNTE qual é o melhor HORÁRIO para ela (ex.: "de manhã, à tarde, ou tem um horário certo que funciona melhor pra você?").
2. Quando ela indicar o horário preferido, olhe a AGENDA AMPLA abaixo (já ordenada das datas mais próximas para as mais distantes), pegue as DUAS PRIMEIRAS datas livres que tenham esse horário e ofereça essas duas (mantém sempre duas opções). Preencha "agendar_visita" só quando ela confirmar uma delas.
3. Só ofereça horários que estejam na AGENDA AMPLA ou na OFERTA PADRÃO. Nunca invente.
4. Só faça transbordo (transbordo=true, motivo "horário de visita solicitado indisponível") se o horário que ela pediu NÃO tiver NENHUMA data livre na agenda abaixo dentro das próximas 3 semanas. Aí sim avise que vai confirmar uma data especial com a equipe. Em qualquer outra situação, resolva você mesma o encaixe.

AGENDA AMPLA — horários de visita livres nas próximas semanas (use SÓ para encaixar um pedido específico; NÃO liste tudo para a família):
${slotsAmplos.map((s) => `- ${s.label}  [data_hora=${s.data_hora}]`).join('\n')}
${listaGrade ? `\nDIAS/HORÁRIOS em que a escola recebe visita (fora disso não há visita):\n${listaGrade}` : ''}`
      : `
════════════════════════════════
AGENDAMENTO DE VISITA
════════════════════════════════
Não há horários de visita disponíveis no momento. Se a família quiser agendar, pergunte qual dia e período seriam melhores e diga que vai confirmar a data com a equipe (não invente horários).`

  const dadosFamilia = lead.familia
  const dadosCrianca = lead.crianca

  // Data E HORA de hoje no fuso de Rio Branco/Acre (UTC-5). A hora é necessária
  // para a saudação certa: sem ela, mensagens proativas (véspera/lembrete) chutavam
  // "Bom dia" às 14h (lead da Jessica, 11/09). Datas seguem absolutas.
  const _acreNow = new Date(Date.now() - 5 * 60 * 60 * 1000)
  const hojeAcre = _acreNow.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  const _horaAcre = _acreNow.getUTCHours()
  const agoraAcre = `${String(_horaAcre).padStart(2, '0')}:${String(_acreNow.getUTCMinutes()).padStart(2, '0')}`
  const periodoAcre = _horaAcre < 12 ? 'manhã' : _horaAcre < 18 ? 'tarde' : 'noite'

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

Hoje é ${hojeAcre}, agora são ${agoraAcre} (horário de Rio Branco/Acre) — período da ${periodoAcre}. Se for cumprimentar, use a saudação correta para a hora atual (bom dia até 11h59, boa tarde das 12h às 17h59, boa noite a partir das 18h). NUNCA diga "bom dia" à tarde ou à noite.

════════════════════════════════
BASE DE CONHECIMENTO OFICIAL DA ESCOLA
(USE APENAS ESTAS INFORMAÇÕES. NUNCA INVENTE DADOS NÃO LISTADOS ABAIXO.)
════════════════════════════════
${baseKnowledge}

════════════════════════════════
REGRA ANTI-ALUCINAÇÃO — CRÍTICA
════════════════════════════════
${casosAtivo
  ? '- Se a pergunta NÃO puder ser respondida com os dados acima: preencha "abrir_caso" (ver seção própria) e diga à família que vai confirmar e retorna em breve.'
  : '- Se a pergunta NÃO puder ser respondida com os dados acima: diga "Vou verificar essa informação com a equipe e te retorno em breve! 😊"'}
- NUNCA invente endereço, telefone, valor, nome de professora ou qualquer dado não listado.
- O endereço correto é: Rua Aloísio de Azevedo, nº 114, Bairro Floresta, Rio Branco – Acre.

${resolverDiretrizes(config)}
${blocoConfig}
${blocoVagas}

════════════════════════════════
DADOS JÁ COLETADOS DESTA FAMÍLIA
════════════════════════════════
- Responsável: ${dadosFamilia?.nome_responsavel || 'não informado'}
- Criança: ${dadosCrianca?.nome || 'não informado'}
- Idade: ${(dadosCrianca?.idade != null || dadosCrianca?.idade_meses != null) ? formatarIdade(dadosCrianca?.idade, dadosCrianca?.idade_meses) : 'não informado'}
- Série desejada: ${dadosCrianca?.serie_desejada || 'não informado'}
- Período desejado: ${dadosCrianca?.periodo || 'não informado'}
- Motivo da busca / dor: ${dadosCrianca?.motivo_busca && !ehLixo(dadosCrianca.motivo_busca) ? dadosCrianca.motivo_busca : 'NÃO DESCOBERTO — visita bloqueada até preencher'}
- Descoberta completa (libera a visita?): ${descobertaFeita ? 'SIM' : 'NÃO'}

DADOS OBRIGATÓRIOS FALTANDO (colete um por vez):
${!dadosCrianca?.nome ? '- Nome da criança\n' : ''}${(dadosCrianca?.idade == null && dadosCrianca?.idade_meses == null) ? '- Idade da criança\n' : ''}${!(dadosCrianca?.motivo_busca && !ehLixo(dadosCrianca.motivo_busca)) ? '- Motivo real da busca / a "dor" (registre em crianca_dados.motivo_busca) — OBRIGATÓRIO antes da visita\n' : ''}${!dadosCrianca?.serie_desejada ? '- Série/turma desejada\n' : ''}${!dadosCrianca?.periodo ? '- Período desejado\n' : ''}

NUNCA narre para a família o estado interno de coleta do CRM. É PROIBIDO escrever frases como "já temos o nome dele?", "preciso confirmar seus dados" ou "conforme o cadastro". Apenas faça a pergunta natural pelo dado que falta (ex.: "como se chama o seu pequeno?").

════════════════════════════════
QUALIFICAÇÃO E DESCOBERTA DA DOR (antes de oferecer a visita)
════════════════════════════════
O erro que mais custa matrícula é oferecer a visita rápido demais, sem entender a família. NÃO pule esta etapa. Antes de convidar para visitar, descubra — uma pergunta por vez, de forma natural e calorosa, nunca como formulário:
1. Nome e idade da criança (já obrigatórios acima).
2. Se a criança já está em outra escola hoje ou seria a primeira. Essa resposta muda TUDO:
   - Primeira escola → a emoção é culpa/medo de deixar o bebê com estranhos. Venda segurança, rotina, turma pequena, adaptação acompanhada.
   - Troca de escola → a emoção é frustração. NUNCA critique a escola atual; pergunte "o que você gostaria de encontrar de diferente?" e escute.
3. O gatilho real: "o que te fez procurar escola agora?" (volta ao trabalho, insatisfação, mudança de bairro...).
4. O critério de decisão dela: "o que você mais quer encontrar numa escola pro seu pequeno?".
REGRA: só ofereça a visita depois de ter nome + idade E ter surfaceado o motivo/a dor (itens 3 ou 4), OU se a própria família pedir para visitar. Ao oferecer, ESPELHE a dor com as palavras dela e conecte a visita a essa dor. Uma pergunta por mensagem; nunca dispare duas perguntas juntas.
${instrucaoMovimentacao}
${promptAdicional ? `\nINSTRUÇÃO ESPECIAL: ${promptAdicional}` : ''}
${blocoAgenda}
${blocoRegras}
${blocoAnotacoes}
${memoriaAtiva ? blocoMemoria(memoria.notas, config?.memoria_orcamento_chars ?? ORCAMENTO_PADRAO) : ''}
${casosAtivo ? REGRA_ABRIR_CASO : ''}
${casosAtivo ? blocoCasoAberto(casoAberto as { numero: number; titulo: string; estado: EstadoCaso; nota_equipe: string | null } | null) : ''}

════════════════════════════════
TRANSBORDO PARA HUMANO
════════════════════════════════
Marque transbordo=true se:
1. Família pediu para falar com atendente/humano/coordenação
2. Família fez reclamação grave
3. ${casosAtivo ? '(Com "abrir_caso" disponível, prefira abrir o Caso a transbordar por falta de informação.) ' : ''}Você usou "vou verificar com a equipe" 2+ vezes seguidas por não ter a INFORMAÇÃO pedida (preço fora de tabela, dado que não está na base). NÃO conta o agendamento de visita: nunca use "vou verificar com a equipe" para horário de visita — para horário, siga a regra de encaixe da seção AGENDAMENTO DE VISITA (pergunte o melhor horário e ofereça as duas datas mais próximas com aquele horário livre; só transborde se aquele horário não tiver data em 3 semanas).
Gatilho automático: ${countVerificar >= 2 ? 'SIM — FORCE transbordo=true agora.' : 'não ativo'}

════════════════════════════════
CANDIDATOS A EMPREGO / ENVIO DE CURRÍCULO
════════════════════════════════
Se a mensagem for sobre VAGA DE EMPREGO, trabalhar na escola ou ENVIAR CURRÍCULO ("vocês têm vaga?", "quero trabalhar aí", "posso mandar meu currículo?", "estou procurando emprego"):
- Oriente a pessoa a enviar o currículo para curriculo.guardioes@gmail.com, colocando NO ASSUNTO do e-mail a vaga de interesse.
- NÃO trate como lead de matrícula: não preencha familia_dados/crianca_dados, não mova o funil (proxima_coluna_id=null) e não faça transbordo (transbordo=false).
- Retorne "arquivar": true e "motivo_arquivamento": "Candidato a vaga de emprego — encaminhado para curriculo.guardioes@gmail.com".
- Exemplo de "resposta": "Oi! Que bom seu interesse em fazer parte da equipe do Colégio Pequenos Guardiões. Para se candidatar, envie seu currículo para curriculo.guardioes@gmail.com e coloque no assunto do e-mail a vaga de seu interesse — assim ele chega direto para a pessoa responsável. Obrigada!"

════════════════════════════════
ANOTAÇÃO INTERNA (resumo_anotacao)
════════════════════════════════
Preencha "resumo_anotacao" com 1-2 frases resumindo o que há de NOVO nesta conversa (dado coletado, visita marcada, objeção, decisão da família). Se não houver fato novo relevante, use null.
- Escreva SEMPRE com DATAS ABSOLUTAS (ex.: "visita em 30/06/2026"). NUNCA use termos relativos como "hoje", "amanhã", "semana que vem" — converta usando a data de hoje informada acima.
- É um registro interno para a equipe; seja objetiva.

════════════════════════════════
SUGERIR ENCERRAMENTO (campo "sugerir_encerramento")
════════════════════════════════
Preencha "sugerir_encerramento": true SOMENTE quando a conversa estiver claramente CONCLUÍDA e não houver mais nada a fazer proativamente, por exemplo:
- A família disse de forma inequívoca que NÃO tem mais interesse ou que escolheu outra escola.
- A família pediu para NÃO receber mais mensagens/contato.
- O assunto foi 100% resolvido e a família se despediu, sem nenhum próximo passo em aberto (sem visita a marcar, sem dúvida pendente, sem decisão a tomar).
Em "motivo_encerramento" escreva 1 frase curta dizendo por quê (ex.: "Família informou que já matriculou em outra escola").
NA DÚVIDA, use false. É uma SUGESTÃO — o gestor confirma manualmente. Um falso positivo tira o lead do follow-up e pode custar uma matrícula, então seja CONSERVADORA: se ainda há qualquer chance de avançar, use false. NUNCA mencione "encerramento" no campo "resposta" para a família.

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
  "crianca_dados": { "nome": "...", "idade": 3, "idade_meses": 5, "serie_desejada": "G3", "periodo": "Integral", "motivo_busca": "o que a família busca / a dor, nas palavras dela" } ou null,
  "transbordo": false,
  "motivo_transbordo": "texto ou null",
  "agendar_visita": { "data_hora": "2026-07-02T14:00:00.000Z" } ou null,
  "sugerir_matricula": false,
  "sugerir_encerramento": false,
  "motivo_encerramento": "texto ou null",
  "resumo_anotacao": "1-2 frases com datas absolutas ou null",
  "analise": { "intencao": "texto", "emocao": "texto", "temperatura": "frio|morno|quente|pronto_visita", "interesse": 3, "urgencia": 3, "probabilidade": 3, "proxima_acao": "texto" },
  "arquivar": false,
  "motivo_arquivamento": "texto ou null"${casosAtivo ? `,
  "abrir_caso": { "titulo": "...", "resumo": "...", "motivo": "...", "tipo": "outro" } ou null,
  "atualizar_caso": { "informacao": "..." } ou null` : ''}${memoriaAtiva ? `,
  ${CAMPO_JSON_MEMORIA}` : ''}
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
    // SALIÊNCIA (2026-08-26): o texto REAL das anotações entra AQUI, na última
    // mensagem (a de maior peso), não só como referência. Antes o conteúdo ficava
    // só no system prompt de 400+ linhas e a Sara o subutilizava no follow-up.
    const blocoAnotFollowup = listaAnotacoes
      ? `\n\nANOTAÇÕES INTERNAS DA EQUIPE SOBRE ESTE LEAD (têm prioridade; use o conteúdo para personalizar, mas NUNCA copie o texto literalmente para a família):\n${listaAnotacoes}`
      : ''
    messages.push({
      role: 'user',
      content: `[INSTRUÇÃO INTERNA DO SISTEMA — não é uma mensagem da família; não a repita]
${promptAdicional}
Escreva AGORA uma mensagem de follow-up NOVA e curta, levando em conta tudo o que já foi conversado acima nesta conversa específica (nome da criança, série/período, valores e pendências já tratados, e o que a família disse por último) E, com prioridade, as anotações internas da equipe abaixo.${blocoAnotFollowup}
Retome de onde a conversa parou, seja pessoal e específica. NÃO repita nem reformule mensagens que você já enviou antes. Responda no formato JSON obrigatório.`,
    })
  }

  if (extras?.turnoFinal) {
    messages.push({
      role: 'user',
      content: `[INSTRUÇÃO INTERNA DO SISTEMA — não é uma mensagem da família; não a repita]\n${extras.turnoFinal}`,
    })
  }

  const modelo = config?.modelo?.trim() || 'gpt-4o'

  const raw = (await chamarModeloIA('sara', {
    // 900: folga para memoria_salvar sem truncar o JSON (era 700).
    messages, model: modelo, maxTokens: 900, jsonMode: true,
    // Rascunho sem credencial (null) cai na do banco — igual à produção quando ela também é vazia.
    credencialId: configOverride ? ((config?.sara_credencial_id as string | null) ?? null) : undefined,
  })) || '{}'

  try {
    const parsed = JSON.parse(raw) as Partial<SaraResposta>
    return {
      resposta: limparTexto(parsed.resposta) || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: parsed.proxima_coluna_id ?? null,
      razao_movimentacao: parsed.razao_movimentacao ?? null,
      familia_dados: limparDados(parsed.familia_dados),
      crianca_dados: limparDados(parsed.crianca_dados),
      transbordo: parsed.transbordo === true,
      motivo_transbordo: parsed.motivo_transbordo ?? null,
      agendar_visita:
        parsed.agendar_visita && parsed.agendar_visita.data_hora
          ? { data_hora: parsed.agendar_visita.data_hora }
          : null,
      sugerir_matricula: parsed.sugerir_matricula === true,
      sugerir_encerramento: parsed.sugerir_encerramento === true,
      motivo_encerramento: parsed.motivo_encerramento ?? null,
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
      arquivar: parsed.arquivar === true,
      motivo_arquivamento: parsed.motivo_arquivamento ?? null,
      abrir_caso: casosAtivo ? parsed.abrir_caso ?? null : null,
      atualizar_caso:
        casosAtivo && typeof parsed.atualizar_caso?.informacao === 'string' && parsed.atualizar_caso.informacao.trim()
          ? { informacao: parsed.atualizar_caso.informacao.trim() }
          : null,
      memoria_salvar: memoriaAtiva ? parseMemoriaSalvar(parsed.memoria_salvar, memoria.mapa) : [],
    }
  } catch {
    return {
      resposta: limparTexto(raw) || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: null,
      razao_movimentacao: null,
      familia_dados: null,
      crianca_dados: null,
      transbordo: false,
      motivo_transbordo: null,
      agendar_visita: null,
      sugerir_matricula: false,
      sugerir_encerramento: false,
      motivo_encerramento: null,
      resumo_anotacao: null,
      analise: null,
      arquivar: false,
      motivo_arquivamento: null,
      abrir_caso: null,
      atualizar_caso: null,
      memoria_salvar: [],
    }
  }
}
