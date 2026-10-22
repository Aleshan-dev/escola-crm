// Formatação da idade da criança em "anos e meses".
// A idade fica em duas colunas de crm.criancas: `idade` (anos completos) e
// `idade_meses` (0-11). Bebês entram como "0 anos e 6 meses"; a formatação
// pluraliza corretamente ("1 ano e 5 meses", "2 anos e 1 mês").

export function formatarIdade(
  anos: number | null | undefined,
  meses: number | null | undefined,
): string {
  const a = anos ?? null
  const m = meses ?? null
  if (a == null && m == null) return ''
  const partes: string[] = []
  if (a != null) partes.push(`${a} ${a === 1 ? 'ano' : 'anos'}`)
  if (m != null) partes.push(`${m} ${m === 1 ? 'mês' : 'meses'}`)
  return partes.join(' e ')
}
