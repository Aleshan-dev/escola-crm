import { createServerAdminClient } from '@/lib/supabase-server'
import { enviarPeloCanal } from '@/lib/canais/enviar'
import type { Canal } from '@/lib/canais/tipos'
import { registrarAlerta } from '@/lib/alertas'

// ============================================================================
// Janela de atendimento de 24h (WhatsApp Cloud API).
//
// Regra da Meta: fora de 24h desde a ÚLTIMA mensagem recebida do contato, só é
// possível enviar TEMPLATE aprovado. Texto livre fora da janela retorna 131047.
//
// Responsabilidades:
//   1. registrarJanela       — chamado em TODO webhook de entrada (renova +24h)
//   2. janelaAberta          — decide, ANTES de enviar, se dá para texto livre
//   3. ehErroJanela          — reconhece o 131047 no catch de um envio
//   4. alertarEnvioManual    — cria ALERTA (tela Alertas) p/ enviar à mão — SÓ lead ativo
//   5. enviarTextoComFallback— envia livre; se a janela fechou, cria o alerta
// ============================================================================

type SupaAdmin = ReturnType<typeof createServerAdminClient>

/** Só dígitos, sem DDI 55, sem o 9º dígito: DDD + 8 finais (10 chars). */
export function chaveJanela(telefone: string | null | undefined): string {
  let d = (telefone ?? '').replace(/\D/g, '')
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2) // tira DDI
  if (d.length > 11) d = d.slice(-11)
  if (d.length < 10) return ''
  return d.slice(0, 2) + d.slice(-8) // DDD + 8 finais
}

/**
 * Renova a janela de 24h para um contato. Chamar em TODO webhook de mensagem
 * RECEBIDA (nunca em echo/fromMe). Best-effort: nunca lança.
 */
export async function registrarJanela(supabase: SupaAdmin, telefone: string): Promise<void> {
  const chave = chaveJanela(telefone)
  if (!chave) return
  const agora = new Date()
  const expira = new Date(agora.getTime() + 24 * 60 * 60 * 1000)
  try {
    await supabase.from('whatsapp_janelas').upsert(
      {
        telefone: chave,
        numero_visto: (telefone ?? '').replace(/\D/g, ''),
        ultima_recebida: agora.toISOString(),
        janela_expira: expira.toISOString(),
      },
      { onConflict: 'telefone' }
    )
  } catch (e) {
    console.error('[janela] registrarJanela falhou:', e instanceof Error ? e.message : e)
  }
}

/**
 * true se ainda estamos dentro da janela de 24h (pode mandar texto livre).
 * Em dúvida (erro de leitura) retorna false — o seguro é assumir fechada.
 */
export async function janelaAberta(supabase: SupaAdmin, telefone: string): Promise<boolean> {
  const chave = chaveJanela(telefone)
  if (!chave) return false
  try {
    const { data } = await supabase
      .from('whatsapp_janelas')
      .select('janela_expira')
      .eq('telefone', chave)
      .maybeSingle<{ janela_expira: string }>()
    if (!data?.janela_expira) return false
    return new Date(data.janela_expira).getTime() > Date.now()
  } catch (e) {
    console.error('[janela] janelaAberta falhou:', e instanceof Error ? e.message : e)
    return false
  }
}

/** Detecta o erro de janela expirada (re-engajamento) da Cloud API. */
export function ehErroJanela(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return msg.includes('131047') || /re-?engagement/i.test(msg)
}

type ColunaEmbed = { nome: string | null } | { nome: string | null }[] | null

/** Lead ativo = não arquivado, fora da coluna "Perdidos" e sem motivo de perda. */
function leadInativo(lead: { arquivado: boolean | null; motivo_perda: string | null; colunas: ColunaEmbed } | null): boolean {
  if (!lead) return true
  if (lead.arquivado === true) return true
  if (lead.motivo_perda && lead.motivo_perda.trim()) return true
  const col = lead.colunas
  const nomeColuna = (Array.isArray(col) ? col[0]?.nome : col?.nome) || ''
  return /perdid/i.test(nomeColuna)
}

/**
 * Cria um ALERTA na tela de Alertas para a direção enviar a mensagem MANUALMENTE
 * pelo WhatsApp do celular. Em Coexistência isso é válido — o envio humano pelo
 * app não está sujeito à janela de 24h da API.
 *
 * SÓ cria para LEAD ATIVO: leads arquivados ou perdidos não geram alerta de
 * engajamento (não faz sentido re-engajar quem já saiu do funil).
 * Best-effort: nunca lança.
 */
export async function alertarEnvioManual(opts: {
  telefone: string
  texto: string
  nome?: string
  leadId?: string | null
}): Promise<{ criado: boolean; motivo?: string }> {
  try {
    const admin = createServerAdminClient()

    if (opts.leadId) {
      const { data: lead } = await admin
        .from('leads')
        .select('arquivado, motivo_perda, colunas(nome)')
        .eq('id', opts.leadId)
        .maybeSingle<{ arquivado: boolean | null; motivo_perda: string | null; colunas: ColunaEmbed }>()
      if (leadInativo(lead)) return { criado: false, motivo: 'lead_inativo' }
    }

    const alvo = opts.nome ? `${opts.nome} (${opts.telefone})` : opts.telefone
    await registrarAlerta(
      admin,
      'janela-fechada',
      `O ${alvo} precisa receber esta mensagem (copie e cole no WhatsApp Web):\n\n${opts.texto}`,
      { tipo: 'engajamento', leadId: opts.leadId ?? null }
    )
    return { criado: true }
  } catch (e) {
    console.error('[janela] alertarEnvioManual falhou:', e instanceof Error ? e.message : e)
    return { criado: false, motivo: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Envio conversacional (avulso) com fallback: tenta texto livre; se a Cloud
 * recusar por janela expirada (131047), cria um ALERTA (só p/ lead ativo) para
 * envio manual e devolve `janelaFechada: true` (sem lançar). Outros erros
 * (número inválido, spam, limite) são relançados para o tratamento normal.
 */
export async function enviarTextoComFallback(
  to: string,
  texto: string,
  ctx?: { nome?: string; leadId?: string | null; phoneId?: string | null; familiaId?: string | null; canalEsperado?: Canal | null }
): Promise<{
  enviado: boolean; wid?: string | null; canal?: Canal; canalRef?: string | null; janelaFechada?: boolean; alertaCriado?: boolean
}> {
  try {
    const r = await enviarPeloCanal({
      operacao: 'manual', telefone: to, texto, phoneId: ctx?.phoneId, familiaId: ctx?.familiaId,
      leadId: ctx?.leadId, canalEsperado: ctx?.canalEsperado,
    })
    return { enviado: true, wid: r.wid, canal: r.canal, canalRef: r.canalRef }
  } catch (e) {
    if (!ehErroJanela(e)) throw e
    const r = await alertarEnvioManual({ telefone: to, texto, nome: ctx?.nome, leadId: ctx?.leadId })
    return { enviado: false, janelaFechada: true, alertaCriado: r.criado }
  }
}
