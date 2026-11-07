// Assinatura de mensagens enviadas à família (pedido do gestor, 04/11/2026):
// cada mensagem carrega quem está falando — "Sara:" nas respostas da IA e o nome de
// quem enviou nas respostas humanas pelo painel. Assinamos SÓ o texto que SAI; a linha
// gravada em `mensagens` fica limpa (a coluna `agente` já diz quem falou, e o histórico
// enviado ao modelo não deve ensiná-lo a grudar "Sara:" na própria resposta).

/** Prepõe "Nome:\n" ao texto. Sem nome (vazio), devolve o texto como está. */
export function assinar(nome: string | null | undefined, texto: string): string {
  const n = (nome || '').trim()
  if (!n || !texto) return texto
  // Idempotente: não duplica se o texto já começa com a assinatura.
  if (texto.startsWith(`${n}:`)) return texto
  return `${n}:\n${texto}`
}

/** Primeiro nome, com inicial maiúscula. */
function primeiroNome(s: string): string {
  const t = s.trim().split(/\s+/)[0] || ''
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''
}

/**
 * Nome de assinatura do usuário logado no painel. Usa o nome do metadata do Supabase
 * Auth; na falta, deriva do e-mail (parte local, sem dígitos). Ex.: aleshan87@gmail.com
 * → "Aleshan". Devolve '' se não der para inferir (aí a mensagem sai sem assinatura).
 */
export function nomeAssinaturaDoUsuario(
  user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined
): string {
  const md = (user?.user_metadata || {}) as Record<string, unknown>
  const bruto = String(md.nome || md.full_name || md.name || '').trim()
  if (bruto) return primeiroNome(bruto)
  const email = String(user?.email || '').trim()
  if (email) {
    const local = email.split('@')[0].replace(/[._+-].*$/, '').replace(/\d+$/, '')
    if (local) return primeiroNome(local)
  }
  return ''
}
