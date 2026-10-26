// Leitura do estado dos canais e do canal carimbado na família (banco + env).

import { createServerAdminClient } from '@/lib/supabase-server'
import { normalizarCelular } from '@/lib/telefone'
import type { EstadoCanais } from './tipos'

/** O que está ligado agora. `phoneId` escolhe a conta Cloud do número pelo qual o lead chegou. */
export async function lerEstadoCanais(phoneId?: string | null): Promise<EstadoCanais> {
  const { resolverContaCloud } = await import('@/lib/whatsapp-cloud')
  const { getWahaConfig } = await import('@/lib/waha')
  const { canalNaoOficial, evolutionDiretoConfigurado } = await import('@/lib/evolution')
  const [conta, waha] = await Promise.all([
    resolverContaCloud(phoneId).catch(() => null),
    getWahaConfig(),
  ])
  return {
    cloud: conta?.phone_number_id && conta?.token ? { phoneNumberId: conta.phone_number_id, token: conta.token } : null,
    wahaConfigurado: !!(waha.url && waha.key),
    evolutionConfigurado: evolutionDiretoConfigurado(),
    canalDisparo: canalNaoOficial(),
    wahaSessao: waha.session || null,
    evolutionInstancia: process.env.EVOLUTION_INSTANCE_NAME || null,
  }
}

/**
 * `familias.canal_whatsapp` do contato — pela família (id) quando o chamador
 * sabe, senão pela IDENTIDADE do número (telefone_norm), nunca pelo telefone cru:
 * o mesmo contato chega como +55…, 55… ou sem o 9º dígito.
 *
 * Erro de banco LANÇA: na dúvida sobre o canal da conversa, não envia (ler
 * "sem carimbo" mandaria pelo canal padrão, talvez outro número).
 */
export async function lerCanalDaFamilia(alvo: { familiaId?: string | null; telefone?: string | null }): Promise<string | null> {
  const supabase = createServerAdminClient()
  const q = alvo.familiaId
    ? supabase.from('familias').select('canal_whatsapp').eq('id', alvo.familiaId)
    : alvo.telefone
      ? supabase.from('familias').select('canal_whatsapp')
          .eq('telefone_norm', normalizarCelular(alvo.telefone))
          .order('criado_em', { ascending: true }).limit(1)
      : null
  if (!q) return null
  const { data, error } = await q.maybeSingle<{ canal_whatsapp: string | null }>()
  if (error) throw new Error(`canal da família: ${error.message}`)
  return data?.canal_whatsapp ?? null
}
