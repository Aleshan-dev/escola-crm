/** Quebra a resposta da Sara em balões curtos (máx. 3) — como o manual pede.
 * Primeiro tenta por parágrafos (linha em branco); se vier um bloco único longo,
 * quebra por frases em pedaços de ~160 caracteres. */
export function dividirEmBaloes(texto: string): string[] {
  const porParagrafo = texto.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  let baloes = porParagrafo.length ? porParagrafo : [texto.trim()]

  if (baloes.length === 1 && baloes[0].length > 200) {
    // Protege o ponto de milhar DENTRO de número (R$ 1.297,00) para a quebra por frase
    // não tratá-lo como fim de frase e cortar o valor ao meio (vazou como "R$ 1." +
    // "297,00" em 30/10/2026). A vírgula decimal não é separador de frase, então só o
    // ponto entre dígitos precisa de proteção.
    const PONTO = '\u0001'
    const protegido = baloes[0].replace(/(\d)\.(?=\d)/g, `$1${PONTO}`)
    const frases = protegido.match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) || [protegido]
    baloes = []
    let atual = ''
    for (const f of frases) {
      if (atual && (atual + ' ' + f).length > 160) { baloes.push(atual); atual = f }
      else atual = atual ? `${atual} ${f}` : f
    }
    if (atual) baloes.push(atual)
    baloes = baloes.map((b) => b.split(PONTO).join('.'))
  }

  return baloes.map((b) => b.trim()).filter(Boolean).slice(0, 3)
}
