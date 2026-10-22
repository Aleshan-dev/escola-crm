/** Quebra a resposta da Sara em balões curtos (máx. 3) — como o manual pede.
 * Primeiro tenta por parágrafos (linha em branco); se vier um bloco único longo,
 * quebra por frases em pedaços de ~160 caracteres. */
export function dividirEmBaloes(texto: string): string[] {
  const porParagrafo = texto.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  let baloes = porParagrafo.length ? porParagrafo : [texto.trim()]

  if (baloes.length === 1 && baloes[0].length > 200) {
    const frases = baloes[0].match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) || [baloes[0]]
    baloes = []
    let atual = ''
    for (const f of frases) {
      if (atual && (atual + ' ' + f).length > 160) { baloes.push(atual); atual = f }
      else atual = atual ? `${atual} ${f}` : f
    }
    if (atual) baloes.push(atual)
  }

  return baloes.map((b) => b.trim()).filter(Boolean).slice(0, 3)
}
