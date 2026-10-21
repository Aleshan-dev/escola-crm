/**
 * Log de decisão do roteador/Maestro — para depuração, best-effort.
 *
 * Grava o MÍNIMO (canal, rota, motivo, permite, intenção, confiança, resultado,
 * lead, timestamp) na tabela aditiva `roteador_decisoes`. NUNCA despeja texto da
 * conversa, nome ou dado da criança (prompt §9). Falha de gravação não derruba o
 * atendimento — é só observabilidade.
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import type { DecisaoDaPolitica } from '@/lib/maestro/politica'
import type { RotaResolvida } from './resolver'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export interface DadosDaDecisao {
  leadId: string
  canal: string
  decisao: DecisaoDaPolitica
  /** Resultado da camada de intenção (quando o roteador rodou). */
  resolvida?: RotaResolvida
}

export async function registrarDecisaoRoteador(
  supabase: SupaAdmin,
  { leadId, canal, decisao, resolvida }: DadosDaDecisao
): Promise<void> {
  try {
    await supabase.from('roteador_decisoes').insert({
      lead_id: leadId,
      canal,
      rota: resolvida?.rota ?? decisao.rota,
      motivo: decisao.motivo,
      permite: resolvida?.permite ?? decisao.permite,
      intencao: resolvida?.intencao ?? null,
      confianca: resolvida?.confianca ?? null,
      resultado: resolvida?.resultado ?? 'guarda',
    })
  } catch (e) {
    console.error('registrarDecisaoRoteador falhou (ignorado):', e)
  }
}
