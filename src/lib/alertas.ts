import { createServerAdminClient } from '@/lib/supabase-server'
import { enviarAvisoInterno } from '@/lib/canais/enviar'

// Observabilidade: registra alertas do sistema e (opcionalmente) notifica o admin
// no WhatsApp, com rate limit para não virar spam.
//
// tipo:
//   'sistema'     -> erro técnico. Notifica o admin no WhatsApp (rate limit).
//   'engajamento' -> envio manual fora da janela de 24h. NÃO pinga o admin
//                    (já aparece na tela de Alertas); guarda lead_id p/ vincular.

const JANELA_NOTIF_MS = 30 * 60 * 1000 // no máx. 1 notificação a cada 30 min

export async function registrarAlerta(
  supabase: ReturnType<typeof createServerAdminClient>,
  contexto: string,
  mensagem: string,
  opts?: { tipo?: 'sistema' | 'engajamento'; leadId?: string | null }
): Promise<void> {
  const tipo = opts?.tipo ?? 'sistema'

  // 1) Sempre registra no banco (barato, serve de auditoria/painel)
  const { data: inserido } = await supabase
    .from('alertas_sistema')
    .insert({ contexto, mensagem: mensagem.slice(0, 1000), tipo, lead_id: opts?.leadId ?? null })
    .select('id')
    .single()

  // 2) Só erros de sistema pingam o admin no WhatsApp. Engajamento aparece na
  //    tela de Alertas (/pendentes) e não precisa de push.
  if (tipo !== 'sistema') return

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

    await enviarAvisoInterno(
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
