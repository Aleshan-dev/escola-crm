/**
 * Log de decisão do roteador/Maestro — para depuração, best-effort.
 *
 * Grava o MÍNIMO (canal, rota, motivo, permite, lead, timestamp) na tabela aditiva
 * `roteador_decisoes`. NUNCA despeja texto da conversa, nome ou dado da criança
 * (prompt §9). Falha de gravação não derruba o atendimento — é só observabilidade.
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import type { DecisaoDaPolitica } from '@/lib/maestro/politica'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export interface DadosDaDecisao {
  leadId: string
  canal: string
  decisao: DecisaoDaPolitica
}

export async function registrarDecisaoRoteador(
  supabase: SupaAdmin,
  { leadId, canal, decisao }: DadosDaDecisao
): Promise<void> {
  try {
    await supabase.from('roteador_decisoes').insert({
      lead_id: leadId,
      canal,
      rota: decisao.rota,
      motivo: decisao.motivo,
      permite: decisao.permite,
    })
  } catch (e) {
    console.error('registrarDecisaoRoteador falhou (ignorado):', e)
  }
}
