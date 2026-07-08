import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara } from '@/lib/sara'

// Faz a Sara responder AGORA a última mensagem do lead (continuar de onde parou),
// acionado manualmente pelo atendente na tela do lead.
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id } = await req.json()
  if (!lead_id) return NextResponse.json({ error: 'lead_id obrigatório' }, { status: 400 })

  const { data: lead } = await supabase
    .from('leads')
    .select('familia:familias(telefone)')
    .eq('id', lead_id)
    .single<{ familia: { telefone: string } }>()

  if (!lead?.familia?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })

  try {
    const sara = await gerarRespostaSara(lead_id)
    if (!sara.resposta?.trim()) return NextResponse.json({ error: 'Sara não gerou resposta' }, { status: 500 })

    const result = await evolutionSendText(lead.familia.telefone, sara.resposta)
    const wid = result?.key?.id || null

    await supabase.from('mensagens').insert({
      lead_id,
      direcao: 'out_ia',
      conteudo: sara.resposta,
      whatsapp_message_id: wid,
    })

    if (sara.resumo_anotacao && sara.resumo_anotacao.trim()) {
      await supabase.from('anotacoes').insert({ lead_id, conteudo: sara.resumo_anotacao.trim() })
    }

    return NextResponse.json({ ok: true, resposta: sara.resposta })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
