/**
 * CASOS — regras puras (estados, transições, tipos, validação).
 *
 * Um Caso é uma tarefa de retaguarda que a Sara/o Salomão abrem quando não
 * conseguem resolver algo sozinhos. NÃO é transbordo: a IA continua falando com a
 * família enquanto a equipe decide. Só "escalar" silencia a IA (handoff completo).
 *
 * Espelho do banco: docs/sql/2026-10-22-casos.sql (CHECK de estado, RPCs
 * crm.caso_abrir / crm.caso_transicionar). Ver docs/CASOS.md.
 */

export type EstadoCaso = 'aguardando_equipe' | 'aguardando_familia' | 'concluido' | 'escalado' | 'cancelado'
export type AgenteCaso = 'sara' | 'salomao'
export type OrigemCaso = 'agente' | 'guarda_promessa' | 'manual'

/** Ação que a EQUIPE toma sobre um Caso (tela ou comando no WhatsApp). */
export type AcaoEquipe = 'concluir' | 'pedir_info' | 'escalar'

export const ESTADOS_ABERTOS: EstadoCaso[] = ['aguardando_equipe', 'aguardando_familia']

export const ROTULO_ESTADO: Record<EstadoCaso, string> = {
  aguardando_equipe: 'Aguardando equipe',
  aguardando_familia: 'Aguardando família',
  concluido: 'Concluído',
  escalado: 'Passado para humano',
  cancelado: 'Cancelado',
}

/** Rótulos de assunto. O banco guarda texto livre; fora da lista vira 'outro'. */
export const TIPOS_CASO = {
  vaga: 'Vaga / turma',
  financeiro: 'Financeiro',
  pedagogico: 'Pedagógico',
  agendamento: 'Agendamento',
  documentos: 'Documentos',
  outro: 'Outro',
} as const
export type TipoCaso = keyof typeof TIPOS_CASO

export const LIMITE_TEXTO = 4000
export const LIMITE_TITULO = 200

export function normalizarTipo(tipo: unknown): TipoCaso {
  return typeof tipo === 'string' && tipo in TIPOS_CASO ? (tipo as TipoCaso) : 'outro'
}

export function estaAberto(estado: EstadoCaso): boolean {
  return ESTADOS_ABERTOS.includes(estado)
}

/**
 * O que cada ação da equipe faz com o Caso. Só vale a partir de
 * 'aguardando_equipe' (o servidor exige; corrida/ação repetida = conflito).
 * `retorno`: a IA precisa voltar à conversa para comunicar à família.
 */
export const TRANSICAO_EQUIPE: Record<AcaoEquipe, { para: EstadoCaso; evento: string; retorno: boolean }> = {
  concluir: { para: 'concluido', evento: 'concluido', retorno: true },
  pedir_info: { para: 'aguardando_familia', evento: 'pedido_info', retorno: true },
  escalar: { para: 'escalado', evento: 'escalado', retorno: false },
}

/** Corta e limpa um texto livre; vazio vira null. */
export function textoLimpo(v: unknown, limite = LIMITE_TEXTO): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, limite) : null
}

export interface PedidoAbertura {
  titulo: string
  resumo: string
  motivo: string | null
  tipo: TipoCaso
}

/**
 * Valida o `abrir_caso` que o modelo devolveu. Sem título e sem resumo não há o
 * que a equipe decidir: devolve null (o chamador não abre nada). Título ausente
 * é derivado do resumo.
 */
export function validarAbertura(bruto: unknown): PedidoAbertura | null {
  if (!bruto || typeof bruto !== 'object') return null
  const b = bruto as Record<string, unknown>
  const resumo = textoLimpo(b.resumo)
  const titulo = textoLimpo(b.titulo, LIMITE_TITULO) ?? (resumo ? resumo.slice(0, 80) : null)
  if (!titulo || !resumo) return null
  return { titulo, resumo, motivo: textoLimpo(b.motivo), tipo: normalizarTipo(b.tipo) }
}

/** Valida a nota da equipe numa ação. Escalar aceita nota vazia; as outras não. */
export function validarNota(acao: AcaoEquipe, nota: unknown): { ok: true; nota: string | null } | { ok: false; erro: string } {
  if (typeof nota === 'string' && nota.trim().length > LIMITE_TEXTO) {
    return { ok: false, erro: `Texto acima de ${LIMITE_TEXTO} caracteres.` }
  }
  const n = textoLimpo(nota)
  if (!n && acao !== 'escalar') return { ok: false, erro: 'Escreva a resposta para a IA repassar à família.' }
  return { ok: true, nota: n }
}

/**
 * Instrução interna que a IA recebe no turno de RETORNO (depois da decisão da
 * equipe). A ação vem do botão da pessoa: o modelo não a reinterpreta.
 */
export function instrucaoRetorno(acao: 'concluir' | 'pedir_info', titulo: string, nota: string): string {
  if (acao === 'concluir') {
    return `A equipe da escola resolveu o assunto que você tinha deixado pendente ("${titulo}"). Resposta da equipe: "${nota}".
Escreva AGORA uma mensagem curta e calorosa comunicando isso à família, com suas palavras (não copie a nota literalmente se ela estiver em linguagem interna). Não cite "equipe técnica", sistema, Caso nem ferramenta. Não preencha "abrir_caso". Responda no formato JSON obrigatório.`
  }
  return `Sobre o assunto pendente ("${titulo}"), a equipe da escola precisa de uma informação da família: "${nota}".
Escreva AGORA uma mensagem curta e gentil pedindo essa informação, com suas palavras. Não cite sistema, Caso nem ferramenta. Não preencha "abrir_caso". Responda no formato JSON obrigatório.`
}

/** Bloco de prompt que a IA vê enquanto há um Caso aberto neste lead. */
export function blocoCasoAberto(caso: { numero: number; titulo: string; estado: EstadoCaso; nota_equipe: string | null } | null): string {
  if (!caso) return ''
  if (caso.estado === 'aguardando_familia') {
    return `
════════════════════════════════
ASSUNTO PENDENTE COM A EQUIPE (aguardando a família)
════════════════════════════════
Assunto: "${caso.titulo}". A equipe pediu esta informação da família: "${caso.nota_equipe ?? ''}".
Quando a família responder com essa informação, preencha "atualizar_caso": { "informacao": "o que a família disse, resumido" } e agradeça dizendo que já vai repassar. Enquanto ela não responder, siga a conversa normalmente. NÃO preencha "abrir_caso" (já existe um assunto pendente).`
  }
  return `
════════════════════════════════
ASSUNTO PENDENTE COM A EQUIPE (aguardando a equipe)
════════════════════════════════
Assunto: "${caso.titulo}" — a equipe já está verificando. Se a família perguntar, diga com naturalidade que ainda está confirmando e que avisa assim que tiver a resposta. Siga a conversa normalmente sobre os outros assuntos. NÃO preencha "abrir_caso" (já existe um assunto pendente) e NÃO faça transbordo só por causa deste assunto.`
}

/** Regras de quando abrir um Caso — trecho de prompt comum à Sara e ao Salomão. */
export const REGRA_ABRIR_CASO = `
════════════════════════════════
QUANDO VOCÊ NÃO SABE OU NÃO PODE RESOLVER (campo "abrir_caso")
════════════════════════════════
Se a família perguntar algo que NÃO está nas informações acima, ou pedir algo que depende de uma decisão da escola, NÃO invente e NÃO apenas prometa: preencha "abrir_caso" para a equipe resolver e continue a conversa.
- "abrir_caso": { "titulo": "frase curta do assunto", "resumo": "o que a família quer saber/pedir, com os detalhes que ela deu", "motivo": "por que você não consegue resolver sozinha", "tipo": "vaga|financeiro|pedagogico|agendamento|documentos|outro" }
- Na "resposta", diga em linguagem simples que vai confirmar e retorna em breve. NUNCA cite sistema, ferramenta, "Caso", "chamado" ou "ticket".
- Abra no máximo um por vez. Pedido para falar com uma pessoa, reclamação grave ou irritação continuam sendo TRANSBORDO, não "abrir_caso".
- Se não precisar, use "abrir_caso": null.`
