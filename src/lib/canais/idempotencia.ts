// IDEMPOTÊNCIA POR ENVIO LÓGICO (crm.envio_idempotencia).
//
// A chave identifica a INTENÇÃO ("toque 2 do follow-up deste ciclo, balão 0"),
// não o texto. Antes de falar com o provedor o envio reivindica a chave; num
// retry (cron que rodou de novo, função que caiu depois do POST) a chave já está
// lá e o envio não sai duas vezes.

import { createServerAdminClient } from '@/lib/supabase-server'

/** Uma reivindicação 'pendente' mais nova que isto é de uma execução viva: não retoma. */
export const PENDENTE_TTL_MS = 10 * 60_000

export interface LinhaChave {
  status: 'pendente' | 'enviado' | 'falhou'
  wid: string | null
  atualizado_em: string
}

export type Reivindicacao =
  | { tipo: 'nova' }
  | { tipo: 'retomada' }
  | { tipo: 'ja_enviado'; wid: string | null }
  | { tipo: 'em_andamento' }

/** Decide o que fazer com uma chave que JÁ existe. Pura (testável). */
export function decidirChaveExistente(linha: LinhaChave, agoraMs: number): Reivindicacao {
  if (linha.status === 'enviado') return { tipo: 'ja_enviado', wid: linha.wid }
  if (linha.status === 'pendente' && agoraMs - Date.parse(linha.atualizado_em) < PENDENTE_TTL_MS) {
    return { tipo: 'em_andamento' }
  }
  return { tipo: 'retomada' } // falhou, ou pendente órfão (execução morreu no meio)
}

export interface IdempotenciaDeps {
  reivindicar(chave: string, operacao: string, canal: string): Promise<Reivindicacao>
  concluir(chave: string, status: 'enviado' | 'falhou', wid: string | null, erro?: string): Promise<void>
}

export const idempotenciaPadrao: IdempotenciaDeps = {
  async reivindicar(chave, operacao, canal) {
    const supabase = createServerAdminClient()
    const agora = new Date().toISOString()
    const ins = await supabase.from('envio_idempotencia')
      .insert({ chave, operacao, canal, status: 'pendente', atualizado_em: agora })
    if (!ins.error) return { tipo: 'nova' }
    if (ins.error.code !== '23505') throw new Error(`idempotência: ${ins.error.message}`)

    const { data } = await supabase.from('envio_idempotencia')
      .select('status, wid, atualizado_em').eq('chave', chave).maybeSingle<LinhaChave>()
    if (!data) return { tipo: 'em_andamento' } // sumiu entre o insert e o select: não arrisca
    const d = decidirChaveExistente(data, Date.now())
    if (d.tipo !== 'retomada') return d

    // Retomada atômica: só uma execução troca o mesmo `atualizado_em` antigo.
    const { data: tomou } = await supabase.from('envio_idempotencia')
      .update({ status: 'pendente', canal, erro: null, atualizado_em: agora })
      .eq('chave', chave).eq('atualizado_em', data.atualizado_em).select('chave')
    return Array.isArray(tomou) && tomou.length > 0 ? { tipo: 'retomada' } : { tipo: 'em_andamento' }
  },
  async concluir(chave, status, wid, erro) {
    const supabase = createServerAdminClient()
    await supabase.from('envio_idempotencia')
      .update({ status, wid, erro: erro?.slice(0, 300) ?? null, atualizado_em: new Date().toISOString() })
      .eq('chave', chave)
  },
}
