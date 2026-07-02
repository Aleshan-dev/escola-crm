import { createServerAdminClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'

// Notificações proativas para o WhatsApp do gestor (telefone_transbordo em config_ia).
// Cada tipo tem uma flag liga/desliga; transbordo é sempre enviado (crítico).

export type TipoNotif = 'visita' | 'encerramento' | 'transbordo'

const FLAG_POR_TIPO: Record<TipoNotif, 'notif_visita_agendada' | 'notif_encerramento' | null> = {
  visita: 'notif_visita_agendada',
  encerramento: 'notif_encerramento',
  transbordo: null, // sempre notifica
}

export async function notificarGestor(
  supabase: ReturnType<typeof createServerAdminClient>,
  tipo: TipoNotif,
  mensagem: string
): Promise<void> {
  try {
    const { data: cfg } = await supabase
      .from('config_ia')
      .select('telefone_transbordo, notif_visita_agendada, notif_encerramento')
      .eq('id', 1)
      .single()

    const tel = cfg?.telefone_transbordo
    if (!tel) return

    const flag = FLAG_POR_TIPO[tipo]
    if (flag && cfg && (cfg as Record<string, unknown>)[flag] === false) return

    await evolutionSendText(tel, mensagem)
  } catch (e) {
    console.error('Falha ao notificar o gestor:', e)
  }
}
