/**
 * Normaliza um telefone para a CHAVE DE IDENTIDADE do contato — espelho fiel de
 * crm.fn_normalizar_celular (o trigger que preenche familias.telefone_norm). Usar
 * a mesma regra aqui garante que o casamento de família encontre o contato já
 * existente, independentemente do formato que chegou (+55…, 55…, com/sem o 9º
 * dígito). A identidade é o NÚMERO; não deduplicar por isto foi o que duplicou
 * leads do mesmo responsável.
 *
 * Mora aqui (sem dependências) para o roteamento de canais usar sem puxar o
 * atendimento inteiro; src/lib/atendimento.ts reexporta.
 */
export function normalizarCelular(raw: string): string {
  let d = (raw || '').replace(/\D/g, '')
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  if (d.length === 10) d = d.slice(0, 2) + '9' + d.slice(2)
  if (d.length === 11) return d
  return d.slice(-11)
}
