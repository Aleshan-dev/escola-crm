import { createServerAdminClient } from '@/lib/supabase-server'
import { buscarDiasFechados, calcularSlotsDisponiveis } from '@/lib/disponibilidade'
import { getOcupacaoDireta } from '@/lib/sgei'
import { formatarIdade } from '@/lib/idade'
import { resolverDiretrizes } from '@/lib/maestro/diretrizes'
import { chamarModeloIA } from '@/lib/ia-credenciais'
import type { PrioridadeIA } from '@/lib/ia-rpm'
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
  // A família confirmou um horário ofertado. `slot_id` é o id do slot escolhido
  // (resolvido pelo servidor para o instante UTC exato — ver `slots_ofertados`);
  // `data_hora` é o ISO que o modelo mandou, usado só como fallback quando não há
  // slot casado. NUNCA grave direto o data_hora do modelo para um slot ofertado: ele
  // carimbava a hora de parede como UTC e a visita entrava 2–5h cedo.
  // `hora_acre` ("HH:MM") + `data_acre` opcional ("AAAA-MM-DD") reagendam/agendam por
  // HORA DE PAREDE de Acre, resolvida no servidor (acreWallToUtc) — sem o bug de fuso e
  // sem precisar de um slot pré-ofertado, para encaixar um horário DENTRO DA GRADE que a
  // família pediu (ex.: mudar a visita de hoje de 14:00 para 14:30). Sem data_acre, o
  // servidor usa a data da visita já marcada (mudança no mesmo dia).
  agendar_visita: { data_hora: string | null; slot_id: string | null; data_acre?: string | null; hora_acre?: string | null } | null
  // Horários que a Sara ofertou NESTE turno, cada um com o instante UTC autoritativo
  // (gerado pelo servidor em `calcularSlotsDisponiveis`). O consumidor resolve
  // `agendar_visita.slot_id` por aqui, sem confiar na aritmética de fuso do modelo.
  slots_ofertados: { id: string; data_hora: string }[]
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
  // REENGAJAMENTO AGENDADO (Repescagem): a família quer decidir mais pra frente. A Sara
  // combina um mês/período para retomar e grava a data em `reativar_em` (AAAA-MM-DD). O
  // lead fica DORMENTE (o follow-up não cutuca) até lá; na data, a Sara manda sozinha um
  // toque caloroso que cita o `motivo`. Persistido em atendimento.ts (valida data futura).
  reengajamento: { reativar_em: string | null; motivo: string | null } | null
  // LIGAÇÃO DA DIREÇÃO (26/11/2026): a família disse dia + hora para receber a ligação
  // de 15 min da Direção. Só vem preenchido quando o lead tem convite de ligação aberto
  // (leads.convite_ligacao_em) ou ligação já marcada (reagendamento). Hora de parede de
  // Acre; o servidor (atendimento.ts) valida dia útil/horário e cria a tarefa 'ligacao'.
  agendar_ligacao?: { data_acre: string; hora_acre: string } | null
}

/** Turno extra no fim do histórico (retorno de Caso, reforço da guarda de promessa). */
export type ExtrasSara = {
  turnoFinal?: string
  /** Fila de RPM: turno de conversa = 'alta' (padrão); follow-up = 'baixa' (cede na rajada). */
  prioridade?: PrioridadeIA
  origem?: string
}

// AUDITORIA CMO 2026-07-29 — saneamento da saída da Sara.
// Motivo: o corpus de 402 mensagens mostrou travessão copiado literalmente dos
// exemplos do prompt (7,7% das mensagens), placeholders de template vazados para
// a família ("[nome da criança]") e campos gravados com texto de espera
// ("A confirmar", "...") que passam por dado preenchido no CRM.
// O prompt já proíbe os três; isto é a rede de segurança em código.

const DIAS_SEMANA_PT = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
]

/**
 * Corrige "atropelo de data": a Sara gruda "hoje"/"amanhã" (e às vezes um dia da
 * semana errado) numa data de visita que o modelo copiou do slot. Ex. real (Cris,
 * 04/11): "hoje, quinta-feira, 05/11" sendo que hoje era quarta 04/11 — 05/11 é amanhã.
 * Instrução de prompt não segura (o gpt-4o espelha o "hoje" da conversa), então aqui,
 * em CÓDIGO, a palavra relativa e o dia da semana são recalculados a partir da data
 * DD/MM que aparece no texto, no fuso de Acre. Determinístico, não depende do modelo.
 * `acreNow` é um Date já deslocado para a PAREDE de Acre (lido via getUTC*).
 */
export function corrigirDiaRelativo(texto: string, acreNow: Date): string {
  if (!texto) return texto
  const hojeDD = acreNow.getUTCDate()
  const hojeMM = acreNow.getUTCMonth() + 1
  const amanha = new Date(acreNow.getTime() + 24 * 60 * 60 * 1000)
  const amaDD = amanha.getUTCDate()
  const amaMM = amanha.getUTCMonth() + 1

  // (hoje|amanhã) [sep] [dia-da-semana [sep]] [dia ] DD/MM
  const re =
    /\b(hoje|amanh[ãa])([,\s]+)(?:((?:segunda|ter[çc]a|quarta|quinta|sexta)-feira|s[áa]bado|domingo)[,\s]+)?(?:dia\s+)?(\d{1,2})\/(\d{1,2})/gi

  return texto.replace(re, (_full, _rel, _sep, weekdayPart, dd, mm) => {
    const d = parseInt(dd, 10)
    const m = parseInt(mm, 10)
    let relativo: string
    if (d === hojeDD && m === hojeMM) relativo = 'hoje'
    else if (d === amaDD && m === amaMM) relativo = 'amanhã'
    else relativo = '' // nem hoje nem amanhã: a palavra relativa estava errada, remove

    const partes: string[] = []
    if (relativo) partes.push(relativo)
    if (weekdayPart) {
      const alvo = new Date(Date.UTC(acreNow.getUTCFullYear(), m - 1, d))
      partes.push(DIAS_SEMANA_PT[alvo.getUTCDay()]) // dia da semana real de DD/MM
    }
    const prefixo = partes.length ? partes.join(', ') + ', ' : ''
    return `${prefixo}${dd}/${mm}`
  })
}

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

/**
 * Resgata SÓ o texto de "resposta" de um JSON malformado ou truncado, sem nunca
 * devolver as chaves/escapes crus. Rede de segurança para o catch do parse: em
 * 30/10/2026 um JSON cortado pelo maxTokens caiu no fallback `limparTexto(raw)` e a
 * família recebeu `{ "resposta": "..."` literal, com o valor partido ("R$ 1." + "297,00").
 * Lê do primeiro `"resposta": "` até a aspa de fechamento (ou o fim, se truncado),
 * decodificando os escapes JSON. Devolve null se não achar o campo.
 */
export function extrairRespostaParcial(raw: string): string | null {
  const abre = raw.match(/"resposta"\s*:\s*"/)
  if (!abre) return null
  let out = ''
  for (let i = abre.index! + abre[0].length; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\') {
      const n = raw[i + 1]
      if (n === undefined) break // escape truncado no fim
      if (n === 'u') {
        out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16) || 0)
        i += 5
      } else {
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : n // \" \\ \/ -> o próprio char
        i += 1
      }
      continue
    }
    if (c === '"') break // fim da string de resposta
    out += c
  }
  return out.trim() || null
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
  // Feriados/recessos do Calendário Escolar (ARCA, crm.dias_fechados): sem visita
  // nesses dias. Pedido da Direção em 19/11/2026 — cadastrou no calendário, a
  // agenda já fecha. Buscado uma vez e usado nas duas grades e no prompt.
  const diasFechados = await buscarDiasFechados(supabase, 30)
  const datasFechadas = diasFechados.map((d) => d.data)

  const slots = await calcularSlotsDisponiveis(supabase, {
    quantidade: 2,
    antecedenciaMin: 120,
    maxPorDia: 1,
    diasFechados: datasFechadas,
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
    diasFechados: datasFechadas,
  })

  // IDs estáveis para cada horário ofertado NESTE turno (oferta padrão + agenda ampla,
  // dedup por instante). A Sara devolve o `slot_id` que a família confirmou e o servidor
  // o resolve para o INSTANTE UTC exato — o modelo nunca monta a data/hora, eliminando o
  // bug de fuso (hora de parede carimbada como UTC → visita 2–5h cedo; casos Cris Ferreira
  // e Régis Albuquerque em 29/10). `data_hora` de cada slot já vem correto de gerarSlots.
  const slotsOfertados: { id: string; data_hora: string; label: string }[] = []
  const _slotsVistos = new Set<string>()
  for (const s of [...slots, ...slotsAmplos]) {
    if (_slotsVistos.has(s.data_hora)) continue
    _slotsVistos.add(s.data_hora)
    slotsOfertados.push({ id: `v${slotsOfertados.length + 1}`, data_hora: s.data_hora, label: s.label })
  }
  const idDoSlot = (dataHora: string) =>
    slotsOfertados.find((s) => s.data_hora === dataHora)?.id ?? ''

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
  const listaFechados = diasFechados
    .map((d) => {
      const [a, m, dia] = d.data.split('-')
      return `- ${dia}/${m}/${a}: ${d.motivo}`
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

  // VISITA JÁ MARCADA (pedido da Direção 19/11/2026): a Sara precisa SABER que existe
  // uma visita futura para reagendar quando a família diz que não pode ir. Sem isso ela
  // tratava "não vou conseguir ir" como conversa nova. O servidor (atendimento.ts) já
  // MOVE a visita aberta quando ela preenche agendar_visita — não cria uma segunda.
  const { data: visitaMarcada } = await supabase
    .from('tarefas')
    .select('data_hora')
    .eq('lead_id', leadId)
    .eq('tipo', 'visita')
    .eq('concluida', false)
    .neq('status', 'cancelada')
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle()
  const labelVisitaMarcada = visitaMarcada
    ? new Date(visitaMarcada.data_hora).toLocaleString('pt-BR', {
        timeZone: 'America/Rio_Branco',
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null
  const blocoVisitaMarcada = labelVisitaMarcada
    ? `
════════════════════════════════
VISITA JÁ MARCADA
════════════════════════════════
Esta família JÁ TEM visita marcada: ${labelVisitaMarcada} (horário de Rio Branco/Acre).
- Se a família disser que NÃO VAI PODER ir nesse horário (imprevisto, trabalho, doença, "não vou conseguir"), acolha sem cobrar e PROPONHA REAGENDAR: ofereça as duas opções da OFERTA PADRÃO (ou pergunte o melhor horário e use a AGENDA AMPLA). Quando ela escolher uma, preencha "agendar_visita" com o slot_id dela — o sistema MOVE a visita existente para o novo horário (não cria outra). Só então confirme: "prontinho, remarquei para ...".
- Se ela só quer confirmar a visita atual, NÃO preencha "agendar_visita".
- Se ela não puder agora e não quiser escolher nova data, acolha, diga que fica à disposição para remarcar quando for melhor e NÃO afirme que remarcou nada.`
    : ''

  // LIGAÇÃO DA DIREÇÃO (26/11/2026): a equipe pediu que a Sara convide a família para
  // uma ligação rápida (15 min) da Direção, ou a ligação já está marcada. A Sara pergunta
  // o melhor dia/horário e, quando a família crava dia + hora, preenche agendar_ligacao.
  const { data: ligacaoMarcada } = await supabase
    .from('tarefas')
    .select('data_hora')
    .eq('lead_id', leadId)
    .eq('tipo', 'ligacao')
    .eq('concluida', false)
    .neq('status', 'cancelada')
    .gte('data_hora', new Date().toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle()
  const conviteLigacaoAberto = !!(lead as { convite_ligacao_em?: string | null }).convite_ligacao_em
  const ligacaoAtiva = conviteLigacaoAberto || !!ligacaoMarcada
  const blocoLigacao = ligacaoAtiva
    ? `
════════════════════════════════
LIGAÇÃO DA DIREÇÃO (15 minutos)
════════════════════════════════
${ligacaoMarcada
  ? `A ligação da Direção com esta família JÁ ESTÁ MARCADA: ${new Date(ligacaoMarcada.data_hora).toLocaleString('pt-BR', { timeZone: 'America/Rio_Branco', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} (horário de Rio Branco/Acre). Se a família pedir para mudar, pergunte o novo dia e horário e preencha "agendar_ligacao" com eles — o sistema MOVE a ligação (não cria outra).`
  : 'A Direção da escola quer fazer uma ligação rápida, de uns 15 minutos, para esta família. Você já perguntou (ou vai perguntar) qual o melhor dia e horário para ela receber a ligação.'}
- Horário possível: segunda a sexta, entre 08:00 e 17:45 (Rio Branco/Acre), a partir de amanhã ou de hoje com pelo menos 1 hora de antecedência. Fora disso, explique com gentileza e peça outro horário.
- Quando a família disser um DIA e uma HORA concretos (ex.: "amanhã às 10h", "sexta 14h30"), preencha "agendar_ligacao": { "data_acre": "AAAA-MM-DD", "hora_acre": "HH:MM" } convertendo "amanhã"/dia da semana para a data certa a partir da data de hoje informada acima. Só então confirme: "combinado, a Direção te liga [dia da semana], [DD/MM] às [HH:MM] 😊".
- Se ela disser só o período ("de manhã", "à tarde", "qualquer hora"), pergunte o horário exato antes de preencher. Se pedir para a escola escolher, proponha UM dia útil e hora e só preencha quando ela aceitar.
- NUNCA afirme que marcou sem preencher "agendar_ligacao" neste mesmo turno. NÃO preencha "agendar_visita" por causa da ligação: ligação não é visita.
- Na ligação a Direção vai conversar sobre a vaga e tirar dúvidas. NÃO cite valores, descontos ou condições: diga apenas que a Direção quer conversar pessoalmente.
- Se a família não quiser a ligação, acolha sem insistir e deixe "agendar_ligacao" como null.`
    : ''

  const blocoAgenda = !descobertaFeita && !visitaMarcada
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
${slots.map((s, i) => `Opção ${i + 1} [id=${idDoSlot(s.data_hora)}]: ${s.label}`).join('\n')}
- Ao apresentar, use apenas o texto amigável (ex.: "${slots[0].label}"), sem mostrar o id. Termine com pergunta fechada ("qual encaixa melhor?").
- Quando a família ESCOLHER/CONFIRMAR uma opção, preencha "agendar_visita" com o "slot_id" EXATO daquela opção (o código entre colchetes, ex.: "${idDoSlot(slots[0].data_hora)}") e confirme a visita com alegria. É pelo slot_id que a agenda grava o horário certo — NUNCA monte você mesma a data/hora.
- O QUE NÃO É CONFIRMAÇÃO (nestes casos NUNCA preencha "agendar_visita" nem mova para Visita Agendada): interesse geral ("podemos sim", "quero conhecer"), pedido de prazo ("daqui a 3 semanas", "mês que vem"), condição futura ("quando ele chegar em Rio Branco", "quando conseguir folga") ou promessa de voltar ("depois eu marco", "te aviso"). Aí acolha, deixe a porta aberta e siga a conversa — o lead PERMANECE onde está. Só há agendamento quando ela crava UMA das opções (dia + hora).

SE A FAMÍLIA DISSER QUE NÃO PODE NESSES DOIS HORÁRIOS (regra dura — leia com atenção):
1. NÃO transfira para humano e NÃO diga "vou verificar com a equipe". PERGUNTE qual é o melhor HORÁRIO para ela (ex.: "de manhã, à tarde, ou tem um horário certo que funciona melhor pra você?").
2. Quando ela indicar o horário preferido, olhe a AGENDA AMPLA abaixo (já ordenada das datas mais próximas para as mais distantes), pegue as DUAS PRIMEIRAS datas livres que tenham esse horário e ofereça essas duas (mantém sempre duas opções). Preencha "agendar_visita" só quando ela confirmar uma delas.
3. Só ofereça horários que estejam na AGENDA AMPLA ou na OFERTA PADRÃO. Nunca invente.
4. Só faça transbordo (transbordo=true, motivo "horário de visita solicitado indisponível") se o horário que ela pediu NÃO tiver NENHUMA data livre na agenda abaixo dentro das próximas 3 semanas. Aí sim avise que vai confirmar uma data especial com a equipe. Em qualquer outra situação, resolva você mesma o encaixe.

NUNCA AFIRME UMA MUDANÇA DE AGENDA QUE VOCÊ NÃO EXECUTOU (regra dura):
- Só diga que agendou / reagendou / "já ajustei o horário" / "já deixei marcado/confirmado para as Xh" QUANDO você preencher "agendar_visita" NESTE MESMO turno (com slot_id OU com hora_acre). Se você não vai preencher "agendar_visita", NÃO afirme que marcou nada — apenas ofereça horários ou diga que vai confirmar com a equipe.
- Horário que a família pede FORA da grade de visitas (lista "DIAS/HORÁRIOS" abaixo): NÃO confirme sozinha. Ofereça o horário de visita mais próximo que exista, ou ${casosAtivo ? 'abra um Caso para a equipe confirmar esse horário especial' : 'diga que vai confirmar esse horário com a equipe e retorna'} — nunca diga que está "agendado/confirmado".

REAGENDAR uma visita JÁ MARCADA (a família quer mudar o horário/dia de uma visita que já existe):
- Se o novo horário está DENTRO da grade de visitas, preencha "agendar_visita" com "hora_acre" ("HH:MM", horário de Rio Branco/Acre). Se a mudança é para OUTRO dia, inclua "data_acre" ("AAAA-MM-DD"); se for no MESMO dia da visita atual, pode mandar só "hora_acre". O servidor move a visita para esse horário — aí sim confirme com alegria.
- NÃO use "hora_acre" para um horário fora da grade: nesse caso vale a regra acima (não confirme; ofereça o mais próximo ou acione a equipe).

AGENDA AMPLA — horários de visita livres nas próximas semanas (use SÓ para encaixar um pedido específico; NÃO liste tudo para a família). Ao confirmar um destes, use o "slot_id" entre colchetes:
${slotsAmplos.map((s) => `- [id=${idDoSlot(s.data_hora)}] ${s.label}`).join('\n')}
${listaGrade ? `\nDIAS/HORÁRIOS em que a escola recebe visita (fora disso não há visita):\n${listaGrade}` : ''}${listaFechados ? `\nDIAS SEM ATENDIMENTO (feriado/recesso do calendário escolar — a escola está FECHADA, não há visita; se a família pedir um destes dias, explique que é feriado e ofereça o próximo dia de visita):\n${listaFechados}` : ''}`
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
  // Dia da semana de HOJE e de AMANHÃ, para o modelo NUNCA chutar a data ao narrar
  // "hoje"/"amanhã" (caso Cris Ferreira, 03/11: chamou terça 03/11 de "quarta 04/11").
  const diaSemanaHoje = _acreNow.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long' })
  const _amanhaAcre = new Date(_acreNow.getTime() + 24 * 60 * 60 * 1000)
  const amanhaAcre = _amanhaAcre.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
  const diaSemanaAmanha = _amanhaAcre.toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'long' })
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

Hoje é ${diaSemanaHoje}, ${hojeAcre}; amanhã é ${diaSemanaAmanha}, ${amanhaAcre}. Agora são ${agoraAcre} (horário de Rio Branco/Acre) — período da ${periodoAcre}. Se for cumprimentar, use a saudação correta para a hora atual (bom dia até 11h59, boa tarde das 12h às 17h59, boa noite a partir das 18h). NUNCA diga "bom dia" à tarde ou à noite.
REGRA DE DATA (CRÍTICA): NUNCA calcule nem escreva de cabeça o dia da semana ou a data de uma visita. Ao citar, oferecer ou confirmar um horário, copie EXATAMENTE o rótulo do horário como aparece na lista de horários mais abaixo (ex.: "terça-feira, 03/11 às 15:30"). É PROIBIDO grudar "hoje"/"amanhã"/"hoje mais tarde" numa data de visita — escreva só o rótulo absoluto (dia da semana + DD/MM), nunca a palavra relativa junto. Mesmo que a família diga "hoje?", confira a data do horário contra a data de hoje acima: se o horário NÃO for hoje, corrija com gentileza ("na verdade seria quinta-feira, 05/11") em vez de repetir "hoje". Se o dia da semana que você ia escrever não bater com o rótulo do horário, o rótulo está certo e você está errada.

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
${blocoVisitaMarcada}
${blocoLigacao}
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
REGRA DE IDADE (CRÍTICA)
════════════════════════════════
Em "crianca_dados": "idade" é a idade ATUAL da criança em ANOS COMPLETOS (número inteiro), exatamente como a família disse HOJE. "idade_meses" são os meses ALÉM dos anos (0–11).
- "tem 2 anos" → idade 2, idade_meses 0. "1 ano e meio" → idade 1, idade_meses 6. "9 meses" → idade 0, idade_meses 9. "vai fazer 2 em dezembro" → ela ainda tem 1 → idade 1.
- NUNCA calcule a idade que a criança TERÁ na matrícula ou no próximo ano — registre sempre a idade de HOJE. A série pode ser do ano que vem, mas a IDADE é a atual.
- NUNCA deduza a idade a partir da série. Se a família NÃO disse a idade, deixe "idade" e "idade_meses" como null.
- NÃO repita nem altere uma idade já coletada (mostrada em "DADOS JÁ COLETADOS") a menos que a família informe uma idade nova nesta conversa.

════════════════════════════════
REENGAJAMENTO — FAMÍLIA QUE QUER DECIDIR DEPOIS
════════════════════════════════
Quando a família sinalizar que NÃO vai decidir agora e quer resolver mais pra frente ("decido mais pra frente", "só mês que vem", "só ano que vem", "vou pensar e te aviso lá pra frente"):
- NÃO insista em visita nem em decisão agora, e não fique cutucando. Acolha o tempo da família.
- CONFIRME um mês/período alvo para VOCÊ retomar o contato ("posso te chamar de novo lá por [mês]?"). Se ela só disse algo vago ("ano que vem", "mais pra frente"), pergunte o mês para cravar antes de gravar.
- Preencha "reengajamento.reativar_em" com a data combinada (AAAA-MM-DD; se só souber o mês, use o 1º dia dele) e "reengajamento.motivo" com o que ela disse, em 1 frase ("decidir em fevereiro, quando definir o trabalho"). A data tem que ser FUTURA.
- Se a família NÃO quiser combinar um retorno, deixe "reengajamento" como null e siga normalmente.
- Mova o lead para "Repescagem" (pediu prazo). Você vai retomar SOZINHA na data combinada com uma mensagem calorosa — então feche este turno deixando claro que volta a falar na época, sem pressão.
- Em qualquer outro caso, deixe "reengajamento" como null.

════════════════════════════════
FORMATO JSON OBRIGATÓRIO (sem markdown, sem texto fora do JSON)
════════════════════════════════
{
  "resposta": "texto para a família: no máximo 2 parágrafos curtos separados por linha em branco, cada um com NO MÁXIMO 35 palavras (é WhatsApp, cada parágrafo vira um balão)",
  "proxima_coluna_id": "uuid ou null",
  "razao_movimentacao": "texto ou null",
  "familia_dados": { "nome_responsavel": "...", "email": "..." } ou null,
  "crianca_dados": { "nome": "...", "idade": 3, "idade_meses": 5, "serie_desejada": "G3", "periodo": "Integral", "motivo_busca": "o que a família busca / a dor, nas palavras dela" } ou null,
  "transbordo": false,
  "motivo_transbordo": "texto ou null",
  "agendar_visita": { "slot_id": "v2" } ou { "hora_acre": "14:30", "data_acre": "AAAA-MM-DD" } ou null,
  "sugerir_matricula": false,
  "sugerir_encerramento": false,
  "motivo_encerramento": "texto ou null",
  "resumo_anotacao": "1-2 frases com datas absolutas ou null",
  "analise": { "intencao": "texto", "emocao": "texto", "temperatura": "frio|morno|quente|pronto_visita", "interesse": 3, "urgencia": 3, "probabilidade": 3, "proxima_acao": "texto" },
  "arquivar": false,
  "motivo_arquivamento": "texto ou null",
  "reengajamento": { "reativar_em": "AAAA-MM-DD ou null", "motivo": "texto curto ou null" } ou null${ligacaoAtiva ? `,
  "agendar_ligacao": { "data_acre": "AAAA-MM-DD", "hora_acre": "HH:MM" } ou null` : ''}${casosAtivo ? `,
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

  // "Sara responder agora" / resgate: a conversa pode terminar numa fala NOSSA (Sara ou
  // atendente). O Gemini recusa pedido que termina com turno do modelo (400 "Requests
  // ending with a model turn are not supported" — 07/11/2026, lite e 3.8). Fecha com um
  // turno interno que diz o que fazer, em vez de deixar o modelo "continuar" a própria fala.
  if (messages[messages.length - 1]?.role === 'assistant') {
    messages.push({
      role: 'user',
      content: `[INSTRUÇÃO INTERNA DO SISTEMA — não é uma mensagem da família; não a repita]
A última mensagem da conversa acima foi NOSSA e a família ainda não respondeu a ela. Se ficou algo da família sem resposta, responda isso agora. Se não ficou nada pendente, escreva uma continuação curta e natural, sem repetir nem reformular o que já enviamos. Responda no formato JSON obrigatório.`,
    })
  }

  const modelo = config?.modelo?.trim() || 'gpt-4o'

  const raw = (await chamarModeloIA('sara', {
    // 900: folga para memoria_salvar sem truncar o JSON (era 700).
    messages, model: modelo, maxTokens: 900, jsonMode: true,
    prioridade: extras?.prioridade ?? 'alta', origem: extras?.origem ?? 'sara',
    // 3.8 Flash grátis dá 503 "high demand" em picos: cai para o reserva em vez de calar.
    modeloReserva: (config?.modelo_reserva as string | null | undefined) ?? null,
    // Rascunho sem credencial (null) cai na do banco — igual à produção quando ela também é vazia.
    credencialId: configOverride ? ((config?.sara_credencial_id as string | null) ?? null) : undefined,
  })) || '{}'

  try {
    const parsed = JSON.parse(raw) as Partial<SaraResposta>
    return {
      resposta: corrigirDiaRelativo(limparTexto(parsed.resposta), _acreNow) || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: parsed.proxima_coluna_id ?? null,
      razao_movimentacao: parsed.razao_movimentacao ?? null,
      familia_dados: limparDados(parsed.familia_dados),
      crianca_dados: limparDados(parsed.crianca_dados),
      transbordo: parsed.transbordo === true,
      motivo_transbordo: parsed.motivo_transbordo ?? null,
      agendar_visita:
        parsed.agendar_visita &&
        (parsed.agendar_visita.slot_id || parsed.agendar_visita.data_hora || parsed.agendar_visita.hora_acre)
          ? {
              slot_id: typeof parsed.agendar_visita.slot_id === 'string' ? parsed.agendar_visita.slot_id : null,
              data_hora: typeof parsed.agendar_visita.data_hora === 'string' ? parsed.agendar_visita.data_hora : null,
              data_acre: typeof parsed.agendar_visita.data_acre === 'string' ? parsed.agendar_visita.data_acre : null,
              hora_acre: typeof parsed.agendar_visita.hora_acre === 'string' ? parsed.agendar_visita.hora_acre : null,
            }
          : null,
      slots_ofertados: slotsOfertados.map(({ id, data_hora }) => ({ id, data_hora })),
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
      reengajamento:
        parsed.reengajamento &&
        (typeof parsed.reengajamento.reativar_em === 'string' || typeof parsed.reengajamento.motivo === 'string')
          ? {
              reativar_em:
                typeof parsed.reengajamento.reativar_em === 'string' ? parsed.reengajamento.reativar_em : null,
              motivo: typeof parsed.reengajamento.motivo === 'string' ? parsed.reengajamento.motivo : null,
            }
          : null,
      agendar_ligacao:
        ligacaoAtiva &&
        parsed.agendar_ligacao &&
        typeof parsed.agendar_ligacao.data_acre === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(parsed.agendar_ligacao.data_acre) &&
        typeof parsed.agendar_ligacao.hora_acre === 'string' &&
        /^\d{1,2}:\d{2}$/.test(parsed.agendar_ligacao.hora_acre)
          ? { data_acre: parsed.agendar_ligacao.data_acre, hora_acre: parsed.agendar_ligacao.hora_acre }
          : null,
    }
  } catch {
    // JSON malformado/truncado: NUNCA despejar as chaves cruas para a família.
    // Resgata só o campo "resposta"; se o bruto nem começa como JSON (texto puro do
    // modelo), mantém o comportamento antigo de usar o bruto; senão, mensagem genérica.
    const salvo = extrairRespostaParcial(raw)
    const bruto = salvo ?? (raw.trimStart().startsWith('{') ? '' : raw)
    return {
      resposta: corrigirDiaRelativo(limparTexto(bruto), _acreNow) || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: null,
      razao_movimentacao: null,
      familia_dados: null,
      crianca_dados: null,
      transbordo: false,
      motivo_transbordo: null,
      agendar_visita: null,
      slots_ofertados: slotsOfertados.map(({ id, data_hora }) => ({ id, data_hora })),
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
      reengajamento: null,
    }
  }
}
