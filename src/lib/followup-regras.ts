import { ACRE_SHIFT_MS } from '@/lib/disponibilidade'

// Regras PURAS do follow-up (sem banco) — o cron decide QUANDO agir com base nelas.

export type TriggerNome =
  | 'primeiro_contato'
  | 'confirmacao_visita'
  | 'followup_pos_visita'
  | 'recuperacao'
  | 'reengajamento'
  | 'lembrete_dia'
  | 'resgate_no_show'

// AUDITORIA CMO 2026-07-29 — HORA_MIN estava em 7, contra o JSDoc abaixo, o
// teste desta janela e a POLITICA-ANTI-BLOQUEIO-WHATSAPP.md, que fixam 8h.
// Na prática o follow-up saía às 7h da manhã, num número que já foi bloqueado
// preventivamente uma vez. Restaurado para 8h.
export const HORA_MIN = 8
export const HORA_MAX = 20

/** Hora (0-23) no fuso de Rio Branco/Acre para um instante em ms. */
export function horaAcre(nowMs: number): number {
  return new Date(nowMs + ACRE_SHIFT_MS).getUTCHours()
}

/** Está dentro do horário comercial (8h–20h, Acre)? */
export function dentroHorarioComercial(nowMs: number): boolean {
  const h = horaAcre(nowMs)
  return h >= HORA_MIN && h < HORA_MAX
}

/** Mapeia a etapa do funil para o tipo de follow-up. */
export function triggerPorColuna(nome: string): TriggerNome {
  switch (nome) {
    case 'Capturados':
      return 'primeiro_contato'
    case 'Visita Agendada':
      return 'confirmacao_visita'
    case 'Visita Realizada':
      return 'followup_pos_visita'
    // DRIFT FIX 2026-08-13 — o Kanban ganhou a coluna "No Show" (o lead que falta
    // é movido para cá, não fica mais em "Visita Agendada"). Sem este case a coluna
    // caía no default -> 'reengajamento' e o resgate NUNCA disparava. Ver ADR-004.
    case 'No Show':
      return 'resgate_no_show'
    case 'Repescagem':
      return 'recuperacao'
    default:
      return 'reengajamento'
  }
}

/** Intervalo efetivo (ms) com backoff crescente por tentativa. */
export function intervaloEfetivoMs(intervaloBaseHoras: number, count: number): number {
  return intervaloBaseHoras * (count + 1) * 60 * 60 * 1000
}

export type EntradaElegibilidade = {
  ultimaInteracaoMs: number
  ultimoFollowupMs: number
  entrouColunaMs: number
  intervaloBaseHoras: number
  count: number
}

/** Um lead (não-confirmação-de-visita) está "vencido" para novo follow-up? */
export function estaDevido(e: EntradaElegibilidade, agoraMs: number): boolean {
  const referencia = Math.max(e.ultimaInteracaoMs, e.ultimoFollowupMs, e.entrouColunaMs)
  return referencia + intervaloEfetivoMs(e.intervaloBaseHoras, e.count) <= agoraMs
}

/** O lead respondeu depois do último follow-up? (reengajou -> zera contador) */
export function respondeuAposFollowup(ultimaInteracaoMs: number, ultimoFollowupMs: number): boolean {
  return ultimoFollowupMs > 0 && ultimaInteracaoMs > ultimoFollowupMs
}

/** A visita agendada é amanhã (no fuso de Acre)? — caso especial da confirmação. */
export function ehVisitaAmanha(dataVisitaMs: number, agoraMs: number): boolean {
  const wVisita = new Date(dataVisitaMs + ACRE_SHIFT_MS)
  const wAmanha = new Date(agoraMs + ACRE_SHIFT_MS + 24 * 60 * 60 * 1000)
  return (
    wVisita.getUTCFullYear() === wAmanha.getUTCFullYear() &&
    wVisita.getUTCMonth() === wAmanha.getUTCMonth() &&
    wVisita.getUTCDate() === wAmanha.getUTCDate()
  )
}

/** A visita é hoje (no fuso de Acre)? — caso do lembrete do dia. */
export function ehVisitaHoje(dataVisitaMs: number, agoraMs: number): boolean {
  const wVisita = new Date(dataVisitaMs + ACRE_SHIFT_MS)
  const wHoje = new Date(agoraMs + ACRE_SHIFT_MS)
  return (
    wVisita.getUTCFullYear() === wHoje.getUTCFullYear() &&
    wVisita.getUTCMonth() === wHoje.getUTCMonth() &&
    wVisita.getUTCDate() === wHoje.getUTCDate()
  )
}

/** A visita já passou há mais de `horas`? — candidato a no-show. */
export function visitaPassou(dataVisitaMs: number, agoraMs: number, horas = 2): boolean {
  return dataVisitaMs > 0 && dataVisitaMs + horas * 60 * 60 * 1000 <= agoraMs
}

/** Dias de silêncio (após esgotar os follow-ups) para dar o lead como perdido. */
export const DIAS_SILENCIO_PERDIDO = 7

/**
 * O lead deve virar "Perdido" por silêncio?
 * Regra: já esgotou os follow-ups da etapa e passou N dias desde o último follow-up
 * sem resposta (qualquer resposta zera o contador e reativa o follow-up, então um lead
 * ainda "esgotado" é porque continuou sem responder).
 */
export function deveMarcarPerdidoPorSilencio(
  ultimoFollowupMs: number,
  agoraMs: number,
  diasSilencio: number = DIAS_SILENCIO_PERDIDO
): boolean {
  if (ultimoFollowupMs <= 0) return false
  return agoraMs - ultimoFollowupMs >= diasSilencio * 24 * 60 * 60 * 1000
}

// AUDITORIA CMO 2026-07-29 — reescrita do promptPorTrigger.
// Dois defeitos corrigidos aqui:
// 1. As instruções antigas traziam FRASES PRONTAS entre aspas (com travessão e
//    data relativa). O modelo copiava literalmente: foi a origem rastreada dos
//    travessões em 7,7% das mensagens. Agora tudo é descrição de INTENÇÃO.
// 2. O reforço só variava o grau de insistência ("seja breve e gentil"), então
//    os toques repetiam a mesma cobrança com outras palavras. Agora cada toque
//    MUDA DE ÂNGULO (ver docs/PLAYBOOK-SCRIPTS-WHATSAPP-SARA.md, Cenário 5).

/**
 * Ângulo de abordagem por número da tentativa.
 * Repetir a mesma cutucada é o que faz a família denunciar o número
 * (ver docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md).
 */
export function anguloPorTentativa(tentativa: number): string {
  switch (tentativa) {
    case 1:
      return ' Este é o primeiro reforço: reduza ao mínimo o custo de responder. Faça UMA pergunta curta e fácil, que se responda em uma palavra. Não peça visita ainda.'
    case 2:
      return ' Este é o segundo reforço: entregue valor ANTES de pedir qualquer coisa. Cite um diferencial concreto da escola e só então faça sua pergunta.'
    case 3:
      return ' Este é o terceiro reforço: mude para uma pergunta de alternativa que dê saída digna, perguntando se a família ainda procura escola ou já resolveu de outro jeito. Deixe claro que qualquer resposta está ótima. Sem pressão.'
    default:
      return ' Este é o último reforço da rotina: seja breve, ancore em algo concreto e verdadeiro, e feche o ciclo com elegância, deixando claro que se não for o momento está tudo bem. Nunca pressione.'
  }
}

/**
 * Trava de FORMA + ABERTURA compartilhada por todos os prompts de follow-up. Entra no
 * fim do system prompt (alta saliência) e repete as travas do Sara 6.1 contra cópia
 * literal.
 *
 * AUDITORIA CMO 2026-10-29 — ABERTURA. Nenhum prompt instruía a PRIMEIRA linha, que num
 * follow-up (lead que já sumiu) é o que decide se a família lê ou arquiva. Sem isso a
 * Sara abria com "oi, tudo bem?" genérico. A abertura puxa o primeiro nome da CRIANÇA
 * quando conhecido (a maior alavanca de relacionamento numa escola — "aqui seu filho é
 * conhecido"); o nome já está no contexto da Sara (DADOS JÁ COLETADOS). Condicional
 * ("quando você já o souber") para não colidir com o primeiro_contato, onde o nome ainda
 * não existe.
 */
export const FORMA =
  ' ABERTURA: a primeira linha decide se a família lê ou arquiva a mensagem, então comece por algo específico desta conversa (o primeiro nome da criança quando você já o souber, um detalhe da visita ou do que a família falou por último), nunca por saudação genérica como "oi, tudo bem?".' +
  ' FORMA: no máximo 2 balões curtos. Nunca use travessão. Datas sempre absolutas, com dia da semana e data. Escreva com as palavras desta conversa, nunca copie frases prontas.'

/**
 * Cronograma do pós-visita: offsets (em horas) a partir de `entrou_coluna_em`.
 * D0 (imediato — mantém o comportamento de 02/09), D3, D7, D10, D14 = 5 toques em 14 dias.
 * O ebook "Captação Previsível" trata o pós-visita como o vazamento nº 3 e pede
 * 5 pontos de contato em 14 dias, cada um com intenção própria (promptPosVisitaPorToque).
 * Substitui o antigo backoff (base*(count+1)) SÓ para a coluna "Visita Realizada".
 */
export const POS_VISITA_TOQUES_HORAS = [0, 72, 168, 240, 336] as const

/** Quantos toques o cronograma de pós-visita prevê. */
export const POS_VISITA_MAX_TOQUES = POS_VISITA_TOQUES_HORAS.length

/**
 * O próximo toque de pós-visita já está vencido?
 * `toquesEnviados` = quantos toques já saíram NESTA entrada na coluna (é o índice do
 * próximo no cronograma). Baseado no tempo desde a entrada na coluna, não em backoff.
 */
export function estaDevidoPosVisita(entrouColunaMs: number, toquesEnviados: number, agoraMs: number): boolean {
  if (entrouColunaMs <= 0) return false
  if (toquesEnviados < 0 || toquesEnviados >= POS_VISITA_TOQUES_HORAS.length) return false
  const offsetMs = POS_VISITA_TOQUES_HORAS[toquesEnviados] * 60 * 60 * 1000
  return entrouColunaMs + offsetMs <= agoraMs
}

/** Texto do prompt que orienta a Sara conforme o gatilho. */
export function promptPorTrigger(trigger: TriggerNome, nome: string, tentativa: number): string {
  const angulo = tentativa >= 2 ? anguloPorTentativa(tentativa - 1) : ''

  // Reforço de forma compartilhado (ver FORMA).
  const forma = FORMA

  switch (trigger) {
    case 'primeiro_contato':
      return `Faça o primeiro contato com ${nome}. A família entrou em contato mas ainda não houve atendimento. Apresente-se como Sara, consultora do Colégio Pequenos Guardiões, com acolhimento. Seu objetivo nesta mensagem é UM SÓ: descobrir o nome e a idade da criança. Peça as duas coisas numa única pergunta curta e não peça mais nada. NÃO ofereça visita nesta mensagem: você ainda não sabe a idade e não tem como saber se há vaga.${angulo}${forma}`
    case 'confirmacao_visita':
      return `Confirme a visita já agendada com ${nome}. Seja calorosa, repita o dia da semana, a data, o horário e o endereço, e PEÇA UMA CONFIRMAÇÃO EXPLÍCITA de que a família virá, pedindo que responda com uma palavra. A confirmação explícita é o que derruba o no-show, então não termine sem pedi-la.${angulo}${forma}`
    case 'lembrete_dia':
      return `Lembre ${nome} de que a visita acontece hoje. Reforce o horário e o endereço com entusiasmo genuíno, diga que estará esperando e ofereça ajuda caso surja algum imprevisto na chegada. Escreva a data por extenso mesmo sendo hoje, porque a mensagem pode ser lida depois.${angulo}${forma}`
    case 'resgate_no_show':
      return `${nome} não compareceu à visita agendada. Seja acolhedora e NUNCA cobre nem crie constrangimento: normalize o ocorrido lembrando que a rotina com criança pequena é corrida. Ofereça remarcar propondo DOIS horários concretos, com dia da semana, data e hora.${angulo}${forma}`
    case 'followup_pos_visita':
      // AUDITORIA CMO 2026-10-29 — este toque empilhava reconhecer a visita + abrir a
      // objeção + propor vaga + ancorar preço + pergunta fechada, tudo em 2 balões: vira
      // mensagem "vendedora", o oposto de relacionamento. Enxugado para UM movimento
      // (reconhecer + UMA pergunta que abra a objeção). Vaga e preço só quando a objeção
      // aparecer (a conversa reativa assume) ou no D10, que já faz o próximo passo. Só
      // dirige o D0 (promptPosVisitaPorToque case 0); os demais toques têm prompt próprio.
      return `${nome} VISITOU a escola e não respondeu mais. É um lead QUENTE, e o silêncio depois da visita quase sempre esconde uma objeção não dita (preço, alinhar com o cônjuge, comparação com outra escola). Faça UMA coisa só nesta mensagem: reconheça a visita citando um detalhe concreto das anotações e faça UMA pergunta que dê à família permissão de dizer o que travou, oferecendo as hipóteses mais prováveis. NÃO empilhe proposta de vaga nem valores agora: se a objeção for preço, isso se trata quando ela aparecer. Feche nessa única pergunta.${angulo}${forma}`
    case 'recuperacao':
      // AUDITORIA CMO 2026-10-29 — o corpo mandava SEMPRE "proponha dois horários", mas a
      // partir do 2º toque o angulo somado pede o oposto (reduza o custo, não peça visita).
      // No reforço o corpo cede ao ângulo; a proposta de visita fica só no 1º toque.
      return tentativa >= 2
        ? `Recupere ${nome}, que está há dias sem avançar e já recebeu um toque seu sem resposta. NÃO repita a proposta de visita do toque anterior: conduza conforme o ângulo indicado abaixo, que muda a abordagem para não soar cobrança. Reforce no máximo UM diferencial concreto e verdadeiro (a turma de no máximo 10 crianças, o acompanhamento próximo da rotina). Faça UMA pergunta só.${angulo}${forma}`
        : `Recupere ${nome}, que está há dias sem avançar. Seja calorosa e ATIVA. Reforce um diferencial concreto, como a turma de no máximo 10 crianças e o acompanhamento próximo da rotina, e PROPONHA um próximo passo concreto: dois horários de visita com dia e data, ou segurar a vaga da criança. Faça UMA pergunta fechada, nunca dois pedidos na mesma mensagem.${forma}`
    case 'reengajamento':
      // AUDITORIA CMO 2026-10-29 — mesmo conflito da recuperacao: o corpo propunha visita
      // em todo toque, colidindo com o ângulo do reforço. No reforço, segue o ângulo.
      return tentativa >= 2
        ? `Retome com ${nome}, que demonstrou interesse, parou de responder ANTES de agendar a visita e já recebeu um toque seu sem resposta. NÃO repita a proposta do toque anterior: conduza conforme o ângulo indicado abaixo. Só fale em horários de visita se você já souber o nome e a idade da criança E o próprio ângulo pedir um próximo passo; caso contrário, apenas siga o ângulo. NUNCA invente escassez de vagas. Faça UMA pergunta só.${angulo}${forma}`
        : `Retome com ${nome}, que demonstrou interesse mas parou de responder ANTES de agendar a visita. Seja calorosa e ATIVA. Em vez de se colocar à disposição, PROPONHA conhecer a escola oferecendo DOIS horários concretos, cada um com dia da semana, data e hora. Só ofereça horários se você já souber o nome e a idade da criança; se ainda não souber, use esta mensagem para perguntar isso. Se for verdade que a turma da idade dela tem poucas vagas, dê esse motivo para ser agora, mas NUNCA invente escassez. Faça UMA pergunta fechada e fácil de responder.${forma}`
  }
}

/**
 * Conteúdo do pós-visita por MARCO do cronograma (índice do toque, 0-based:
 * 0=D0, 1=D3, 2=D7, 3=D10, 4=D14). Diferente de promptPorTrigger, cada toque muda de
 * INTENÇÃO (não só de ângulo), seguindo os 5 pontos de contato do ebook. Nunca frases
 * prontas; sempre com a trava FORMA. `depoimento` é um gancho de config: se preenchido,
 * o toque D7 vira prova social; senão, mensagem de valor.
 */
export function promptPosVisitaPorToque(nome: string, toque: number, depoimento?: string | null): string {
  switch (toque) {
    case 0:
      // D0 — reaproveita a abordagem quente de pós-visita (agradecer + trazer a objeção).
      return promptPorTrigger('followup_pos_visita', nome, 1)
    case 1:
      // D3 — check-in leve, sem cobrança.
      return `${nome} visitou o Colégio Pequenos Guardiões há alguns dias e não respondeu mais. Faça um check-in leve, sem NENHUMA cobrança: reconheça a visita e faça UMA pergunta curta e fácil sobre o que a família achou ou se ficou alguma dúvida sobre o que viram. Não peça visita nem decisão nesta mensagem.${FORMA}`
    case 2:
      // D7 — prova social (se houver depoimento) ou mensagem de valor.
      if (depoimento && depoimento.trim()) {
        return `${nome} visitou a escola e segue avaliando. Traga uma prova social concreta: comente com naturalidade, nas suas palavras, este relato de outra família da escola: "${depoimento.trim()}". Conecte com algo que ${nome} pôde ver na visita e feche com UMA pergunta leve. Não pressione.${FORMA}`
      }
      return `${nome} visitou a escola e segue avaliando. Reforce UM diferencial concreto e verdadeiro do Colégio Pequenos Guardiões, como a turma de no máximo 10 crianças e o acompanhamento próximo da rotina, conectando com algo que a família pôde ver na visita. Feche com UMA pergunta leve, sem pressão.${FORMA}`
    case 3:
      // D10 — próximo passo concreto: coordenação ou nova visita, com horários.
      return `${nome} visitou a escola e ainda não decidiu. Ofereça um próximo passo concreto: uma conversa com a coordenação pedagógica para tirar dúvidas, ou uma nova passada na escola. Proponha DOIS horários concretos, cada um com dia da semana, data e hora. Faça UMA pergunta fechada.${FORMA}`
    default:
      // D14 — fechamento gentil com prazo suave.
      return `${nome} visitou a escola há cerca de duas semanas e não avançou. Este é o fechamento gentil do acompanhamento: ancore em algo concreto e verdadeiro, ofereça segurar a vaga da criança na turma por um prazo curto e deixe MUITO claro que, se não for o momento, está tudo bem. Sem pressão. Feche com UMA pergunta fechada e fácil.${FORMA}`
  }
}
