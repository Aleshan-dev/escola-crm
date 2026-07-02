import { createServerAdminClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'

// Observabilidade: registra falhas do sistema e notifica o admin no WhatsApp,
// com rate limit para não virar spam (nem gatilho de bloqueio).

const JANELA_NOTIF_MS = 30 * 60 * 1000 // no máx. 1 notificação a cada 30 min

export async function registrarAlerta(
  supabase: ReturnType<typeof createServerAdminClient>,
  contexto: string,
  mensagem: string
): Promise<void> {
  // 1) Sempre registra no banco (barato, serve de auditoria/painel)
  const { data: inserido } = await supabase
    .from('alertas_sistema')
    .insert({ contexto, mensagem: mensagem.slice(0, 1000) })
    .select('id')
    .single()

  // 2) Notifica no WhatsApp do admin, com rate limit
  try {
    const desde = new Date(Date.now() - JANELA_NOTIF_MS).toISOString()
    const { data: recentes } = await supabase
      .from('alertas_sistema')
      .select('id')
      .eq('notificado', true)
      .gte('criado_em', desde)
      .limit(1)
    if (recentes && recentes.length > 0) return // já avisou há pouco

    const { data: cfg } = await supabase
      .from('config_ia')
      .select('telefone_transbordo')
      .eq('id', 1)
      .single()
    const tel = cfg?.telefone_transbordo
    if (!tel) return

    await evolutionSendText(
      tel,
      `🚨 *Alerta do sistema*\nContexto: ${contexto}\n${mensagem.slice(0, 300)}\n\nVerifique o CRM.`
    )
    if (inserido?.id) {
      await supabase.from('alertas_sistema').update({ notificado: true }).eq('id', inserido.id)
    }
  } catch {
    // Um alerta nunca pode derrubar o fluxo principal.
  }
}
