/** Quebra a resposta da Sara em balões curtos de WhatsApp.
 *
 * 10/11/2026 (pedido do gestor): no máximo 35 PALAVRAS por balão — textos longos num
 * balão só leem como robô. Ordem de quebra: parágrafo → frase → oração (vírgula, ponto
 * e vírgula, dois-pontos) → corte por palavras. Nunca descarta texto: o antigo teto de
 * 3 balões cortava o fim da resposta (às vezes o próprio valor). */

export const MAX_PALAVRAS_BALAO = 35
// Rede de segurança contra rajada: acima disso o excedente é juntado no último balão
// (o prompt já pede respostas curtas; isto só evita 10 balões seguidos se o modelo
// desandar). Juntar é melhor que descartar.
const MAX_BALOES = 6

const contar = (s: string) => s.split(/\s+/).filter(Boolean).length

// Protege o ponto de milhar DENTRO de número (R$ 1.297,00): sem isso a quebra por frase
// o trata como fim de frase e corta o valor ao meio (vazou como "R$ 1." + "297,00" em
// 30/10/2026). Vírgula decimal entre dígitos também não é separador de oração.
const PONTO = '\u0001'
const VIRGULA = '\u0002'
const DOIS_PONTOS = '\u0003' // horário "07:00"
const proteger = (s: string) =>
  s
    .replace(/(\d)\.(?=\d)/g, `$1${PONTO}`)
    .replace(/(\d),(?=\d)/g, `$1${VIRGULA}`)
    .replace(/(\d):(?=\d)/g, `$1${DOIS_PONTOS}`)
const restaurar = (s: string) => s.split(PONTO).join('.').split(VIRGULA).join(',').split(DOIS_PONTOS).join(':')

/** Junta pedaços em sequência sem passar de `max` palavras por grupo. */
function empacotar(pedacos: string[], max: number): string[] {
  const out: string[] = []
  let atual = ''
  for (const p of pedacos) {
    const junto = atual ? `${atual} ${p}` : p
    if (atual && contar(junto) > max) {
      out.push(atual)
      atual = p
    } else {
      atual = junto
    }
  }
  if (atual) out.push(atual)
  return out
}

/** Garante que nenhum pedaço passe de `max` palavras, descendo de nível quando precisa. */
function quebrar(texto: string, max: number): string[] {
  if (contar(texto) <= max) return [texto]

  const frases = texto.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [texto]
  if (frases.length > 1) return empacotar(frases.flatMap((f) => quebrar(f, max)), max)

  // Uma frase só, longa: quebra por oração, mantendo a pontuação no fim de cada parte.
  const oracoes = texto.match(/[^,;:]+[,;:]?\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [texto]
  if (oracoes.length > 1) {
    return empacotar(
      oracoes.flatMap((o) => (contar(o) > max ? cortarPorPalavras(o, max) : [o])),
      max
    )
  }
  return cortarPorPalavras(texto, max)
}

function cortarPorPalavras(texto: string, max: number): string[] {
  const palavras = texto.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < palavras.length; i += max) out.push(palavras.slice(i, i + max).join(' '))
  return out
}

export function dividirEmBaloes(texto: string, maxPalavras = MAX_PALAVRAS_BALAO): string[] {
  const paragrafos = proteger(texto || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

  let baloes = paragrafos.flatMap((p) => quebrar(p, maxPalavras)).map((b) => restaurar(b).trim()).filter(Boolean)

  if (baloes.length > MAX_BALOES) {
    baloes = [...baloes.slice(0, MAX_BALOES - 1), baloes.slice(MAX_BALOES - 1).join(' ')]
  }
  return baloes
}
