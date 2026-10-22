/**
 * MEMÓRIA DURÁVEL DO LEAD — regras puras (sem I/O). Ideia trazida do lead_notes do
 * DeskcommCRM: fatos que duram (título + corpo) e que a Sara e o Salomão lembram
 * além da janela de 20 mensagens. Convive com crm.anotacoes (diário da equipe).
 *
 * O modelo nunca vê uuid: as notas entram no prompt como M1..Mn e o mapa curto→uuid
 * fica no servidor. Espelho SQL: docs/sql/2026-10-22-memoria-lead.sql (limites,
 * normalização do título e custo de uma nota precisam bater com crm.memoria_salvar).
 */

export const MAX_TITULO = 140
export const MAX_CORPO = 600
export const MAX_POR_TURNO = 3
export const ORCAMENTO_PADRAO = 2500

export type OrigemMemoria = 'sara' | 'salomao' | 'extracao' | 'equipe'

export interface NotaMemoria {
  id: string
  titulo: string
  corpo: string
  origem: OrigemMemoria
  criado_em: string
  atualizado_em: string
}

/** O que o modelo pediu para gravar, já com `substitui` traduzido para uuid. */
export interface PedidoMemoria {
  titulo: string
  corpo: string
  substitui: string[]
}

/** Mesma normalização de crm.memoria_norm: minúsculas, sem acento, só [a-z0-9 ]. */
export function normalizarTitulo(titulo: string): string {
  return titulo
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Custo de uma nota no orçamento (igual ao SQL: título + corpo + 8). */
export function custoNota(n: { titulo: string; corpo: string }): number {
  return n.titulo.length + n.corpo.length + 8
}

export function custoTotal(notas: { titulo: string; corpo: string }[]): number {
  return notas.reduce((s, n) => s + custoNota(n), 0)
}

// Dado que não pode morar na memória: CPF completo, número de cartão, PIX copia e cola.
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/
const CARTAO = /\b(?:\d[ -]?){13,19}\b/
const PIX = /br\.gov\.bcb\.pix/i

export function contemDadoSensivel(texto: string): boolean {
  return CPF.test(texto) || CARTAO.test(texto) || PIX.test(texto)
}

/** Valida uma nota vinda do modelo ou da equipe. Corta excessos; null se inválida. */
export function validarNota(v: unknown): { titulo: string; corpo: string } | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const titulo = typeof o.titulo === 'string' ? o.titulo.replace(/\s+/g, ' ').trim().slice(0, MAX_TITULO) : ''
  const corpo = typeof o.corpo === 'string' ? o.corpo.trim().slice(0, MAX_CORPO) : ''
  if (!titulo || !normalizarTitulo(titulo)) return null
  if (contemDadoSensivel(`${titulo} ${corpo}`)) return null
  return { titulo, corpo }
}

/** Numera as notas (mais antiga = M1) e devolve o mapa curto→uuid. */
export function indexarNotas(notas: NotaMemoria[]): { linhas: { codigo: string; nota: NotaMemoria }[]; mapa: Record<string, string> } {
  const ordenadas = [...notas].sort((a, b) => a.criado_em.localeCompare(b.criado_em))
  const linhas = ordenadas.map((nota, i) => ({ codigo: `M${i + 1}`, nota }))
  const mapa = Object.fromEntries(linhas.map((l) => [l.codigo, l.nota.id]))
  return { linhas, mapa }
}

const dataBR = (iso: string) => {
  const [y, m, d] = (iso || '').slice(0, 10).split('-')
  return y && m && d ? `${d}/${m}/${y}` : ''
}

/**
 * Bloco do prompt: as notas (título + corpo, porque não há function calling para
 * buscar o corpo sob demanda) e a regra de como gravar. Sem truncar: o orçamento é
 * aplicado na escrita; se o conjunto já passou dele, o modelo é avisado para consolidar.
 */
export function blocoMemoria(notas: NotaMemoria[], orcamento: number = ORCAMENTO_PADRAO): string {
  const { linhas } = indexarNotas(notas)
  const lista = linhas.length
    ? linhas.map(({ codigo, nota }) =>
        `- [${codigo}] ${nota.titulo}${nota.corpo ? `: ${nota.corpo}` : ''} (${dataBR(nota.atualizado_em)})`).join('\n')
    : '- (nenhuma memória registrada ainda)'
  const total = custoTotal(notas)
  const aviso = total > orcamento * 0.85
    ? `\nATENÇÃO: a memória está quase cheia (${total}/${orcamento}). Ao gravar, CONSOLIDE: junte notas parecidas numa só e cite as antigas em "substitui".`
    : ''
  return `
════════════════════════════════
MEMÓRIA DESTA FAMÍLIA (fatos duráveis de conversas anteriores)
════════════════════════════════
Use estes fatos para não perguntar de novo o que a família já contou e para personalizar a conversa. NUNCA cite a memória à família ("anotei aqui que...") nem copie o texto literalmente.
${lista}${aviso}

COMO GRAVAR MEMÓRIA (campo "memoria_salvar"):
- Grave SÓ fato DURÁVEL que vale lembrar daqui a semanas: preferência, restrição (alergia, rotina, horário de trabalho), contexto da família (irmãos, mudança, quem decide), objeção, o que já foi oferecido/combinado.
- NÃO grave: o que já está nos dados cadastrais (nome, idade, turma, período), o estado desta conversa ("aguardando resposta"), saudações, nem valores/dívidas/CPF/PIX.
- Título curto e estável (ex.: "Alergia alimentar", "Horário de trabalho da mãe"); corpo com o detalhe e DATAS ABSOLUTAS.
- Fato que corrige ou completa uma nota acima: grave a versão nova e cite a antiga em "substitui" (ex.: ["M2"]). Mesmo título = atualiza.
- No máximo ${MAX_POR_TURNO} por turno. Sem fato novo durável: [].`
}

/** Linha do contrato JSON para os prompts. */
export const CAMPO_JSON_MEMORIA =
  `"memoria_salvar": [{ "titulo": "...", "corpo": "...", "substitui": ["M1"] }] ou []`

/** Lê memoria_salvar da saída do modelo: valida, limita e traduz M# → uuid. */
export function parseMemoriaSalvar(raw: unknown, mapa: Record<string, string>): PedidoMemoria[] {
  if (!Array.isArray(raw)) return []
  const vistos = new Set<string>()
  const saida: PedidoMemoria[] = []
  for (const item of raw) {
    if (saida.length >= MAX_POR_TURNO) break
    const nota = validarNota(item)
    if (!nota) continue
    const chave = normalizarTitulo(nota.titulo)
    if (vistos.has(chave)) continue
    vistos.add(chave)
    const subs = Array.isArray((item as Record<string, unknown>).substitui)
      ? ((item as Record<string, unknown>).substitui as unknown[])
      : []
    const substitui = [...new Set(
      subs
        .map((s) => (typeof s === 'string' ? mapa[s.trim().toUpperCase()] : undefined))
        .filter((s): s is string => !!s)
    )]
    saida.push({ ...nota, substitui })
  }
  return saida
}
