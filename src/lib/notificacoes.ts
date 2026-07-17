import { createServerAdminClient } from '@/lib/supabase-server'
import { enviarTextoWhatsApp, enviarTemplateWhatsApp } from '@/lib/whatsapp-cloud'

// Fallback por template quando o envio livre falha (fora da janela de 24h).
export type TemplateFallback = { name: string; language?: string; variaveis: string[] }

// Notificações proativas para o WhatsApp do gestor (telefone_transbordo em config_ia).
// Cada tipo tem uma flag liga/desliga; transbordo é sempre enviado (crítico).

export type TipoNotif = 'visita' | 'encerramento' | 'transbordo' | 'sugestao_matricula'

const FLAG_POR_TIPO: Record<TipoNotif, 'notif_visita_agendada' | 'notif_encerramento' | null> = {
  visita: 'notif_visita_agendada',
  encerramento: 'notif_encerramento',
  transbordo: null, // sempre notifica
  sugestao_matricula: null, // sempre notifica (baixa frequência, exige ação do gestor)
}

export async function notificarGestor(
  supabase: ReturnType<typeof createServerAdminClient>,
  tipo: TipoNotif,
  mensagem: string,
  opts?: { templateFallback?: TemplateFallback }
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

    try {
      // Tenta o envio livre (grátis dentro da janela de 24h).
      await enviarTextoWhatsApp(tel, mensagem)
    } catch (errLivre) {
      // Fora da janela de 24h o envio livre falha (ex.: 131047). Recai no template
      // aprovado, que entrega a qualquer hora. Se não houver template, propaga.
      if (opts?.templateFallback) {
        await enviarTemplateWhatsApp(
          tel,
          opts.templateFallback.name,
          opts.templateFallback.language || 'pt_BR',
          opts.templateFallback.variaveis
        )
      } else {
        throw errLivre
      }
    }
  } catch (e) {
    console.error('Falha ao notificar o gestor:', e)
  }
}
