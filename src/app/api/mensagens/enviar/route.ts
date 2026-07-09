import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { enviarTextoWhatsApp } from '@/lib/whatsapp-cloud'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id, texto } = await req.json()
  if (!lead_id || !texto) return NextResponse.json({ error: 'lead_id e texto obrigatórios' }, { status: 400 })

  // Pega telefone do lead
  const { data: lead } = await supabase
    .from('leads')
    .select('familia:familias(telefone, whatsapp_phone_number_id)')
    .eq('id', lead_id)
    .single<{ familia: { telefone: string; whatsapp_phone_number_id: string | null } }>()

  if (!lead?.familia?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })

  try {
    const wid = await enviarTextoWhatsApp(lead.familia.telefone, texto, lead.familia.whatsapp_phone_number_id)

    // Salva mensagem
    await supabase.from('mensagens').insert({
      lead_id,
      direcao: 'out_humano',
      conteudo: texto,
      enviado_por: user.id,
      whatsapp_message_id: wid,
    })

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
