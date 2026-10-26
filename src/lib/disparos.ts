import { createServerAdminClient } from '@/lib/supabase-server'
import { normalizarCelularBR } from '@/lib/sgei'
import { telefoneFormatoWhatsApp } from '@/lib/boletos'
import type { ArcaMensagemItem } from '@/lib/arca'

// Registro do comunicado (disparo em massa) no thread do CRM, para aparecer no
// chat da família. Best-effort: nunca lança (o envio já ocorreu e foi confirmado
// no Arca). Diferente dos boletos, um comunicado NÃO cria família nova só para
// logar — se a família não existe no CRM, apenas não registramos (evita poluir o
// funil com famílias sem nome). O casamento por número segue a mesma convenção
// dos boletos (invariante ao 9º dígito).

type SupaAdmin = ReturnType<typeof createServerAdminClient>

// Traduz o MIME do anexo para o mediatype esperado pelo Evolution.
export function mediatypeDe(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'document'
}

export async function registrarDisparoNoChat(
  supabase: SupaAdmin,
  item: ArcaMensagemItem,
  wid: string | null
): Promise<void> {
  try {
    const recon = normalizarCelularBR(item.whatsapp)
    const last8 = (recon || item.whatsapp.replace(/\D/g, '')).slice(-8)
    const telefoneWA = telefoneFormatoWhatsApp(item.whatsapp)

    const { data: familia } = await supabase
      .from('familias')
      .select('id')
      .or(`telefone.eq.${telefoneWA},telefone.ilike.*${last8}`)
      .order('ja_responsavel', { ascending: false })
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!familia) return // comunicado não cria família nova só para logar

    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('familia_id', familia.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!lead) return

    // Idempotência pelo id da mensagem do Evolution (echo fromMe deduplica e
    // NÃO pausa a IA).
    if (wid) {
      const { data: ja } = await supabase
        .from('mensagens')
        .select('id')
        .eq('whatsapp_message_id', wid)
        .maybeSingle()
      if (ja) return
    }

    const temAnexo = item.anexos.length > 0
    // Registramos o texto EXATAMENTE como a família recebeu — sem o rótulo
    // "Comunicado" no início. Anexos ainda são sinalizados (o arquivo em si não
    // entra no log de texto), mas como sufixo discreto, sem poluir o começo.
    const conteudo = temAnexo
      ? (item.mensagem ? `${item.mensagem}\n\n(com anexo)` : '(com anexo)')
      : item.mensagem
    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'out_ia',
      agente: 'salomao',
      agente_origem: 'disparo',
      conteudo,
      whatsapp_message_id: wid,
      tipo_midia: temAnexo ? 'documento' : 'texto',
    })
  } catch (e) {
    console.error('[disparos] registrarDisparoNoChat falhou:', e instanceof Error ? e.message : e)
  }
}
