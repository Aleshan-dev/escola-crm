/**
 * GUARDA DE PROMESSA — detecta, antes do envio, quando a IA promete que alguém
 * vai verificar/retornar SEM ter aberto um Caso. Promessa sem Caso é promessa que
 * ninguém cumpre: a família fica esperando um retorno que não existe.
 *
 * Camada léxica (determinística, sem IA): cobre os padrões conhecidos, não toda
 * paráfrase possível. Modo em config_ia.casos_guarda_promessa: off | log | ativo.
 * Quem aplica (regerar uma vez / abrir Caso mínimo) é o atendimento.ts.
 */

const PADROES: RegExp[] = [
  /\bvou (verificar|checar|confirmar|conferir|consultar|ver)\b/i,
  /\b(vou|irei) (falar|conversar) com a (equipe|secretaria|coordena[çc][ãa]o|dire[çc][ãa]o)\b/i,
  /\b(vou|irei) (repassar|encaminhar|levar)\b.*\b(equipe|secretaria|coordena[çc][ãa]o|dire[çc][ãa]o)\b/i,
  /\ba (equipe|secretaria|coordena[çc][ãa]o|dire[çc][ãa]o) (vai|ir[áa]) (te )?(retornar|responder|confirmar|verificar|entrar em contato)\b/i,
  /\b(te|lhe) (retorno|respondo|aviso|dou um retorno)\b/i,
  /\bretorno em breve\b/i,
  /\bj[áa] (te )?(retorno|volto)\b/i,
]

/** Trecho que caracteriza a promessa, ou null. */
export function detectaPromessaHumana(texto: string): string | null {
  for (const p of PADROES) {
    const m = p.exec(texto || '')
    if (m) return m[0]
  }
  return null
}

export type ModoGuarda = 'off' | 'log' | 'ativo'

export function modoGuarda(v: unknown): ModoGuarda {
  return v === 'off' || v === 'ativo' ? v : 'log'
}

/** Instrução da segunda (e última) tentativa, quando a primeira prometeu sem Caso. */
export const INSTRUCAO_REFORCO =
  'Sua resposta anterior prometeu verificar ou retornar à família, mas você não preencheu "abrir_caso". Ou preencha "abrir_caso" (se realmente precisa da escola para responder), ou reescreva a resposta sem prometer retorno. Responda no formato JSON obrigatório.'
