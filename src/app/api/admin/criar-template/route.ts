import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Cria/submete o template de follow-up "retomada_lead" à Meta, usando o waba_id +
// token da conta WhatsApp ativa (guardados no banco). Session-authed: o token
// nunca sai do servidor. A Meta analisa e aprova (minutos a ~1 dia).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const admin = createServerAdminClient()
  const { data: conta } = await admin
    .from('whatsapp_contas')
    .select('waba_id, token')
    .eq('ativo', true)
    .not('waba_id', 'is', null)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!conta?.waba_id || !conta?.token) {
    return NextResponse.json({ error: 'Conta WhatsApp ativa sem waba_id/token.' }, { status: 400 })
  }

  const template = {
    name: 'retomada_lead',
    language: 'pt_BR',
    category: 'MARKETING',
    components: [
      {
        type: 'BODY',
        text:
          'Olá, {{1}}! 😊 Aqui é a Sara, do Colégio Pequenos Guardiões. Passando para saber se você ainda gostaria de conhecer nossa escola e agendar uma visita. Estou por aqui para ajudar com qualquer dúvida!',
        example: { body_text: [['Maria']] },
      },
    ],
  }

  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${conta.waba_id}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${conta.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(template),
    })
    const j = await r.json()
    if (!r.ok) {
      return NextResponse.json(
        { error: j?.error?.message || 'Falha ao criar template', detalhe: j?.error },
        { status: 400 }
      )
    }
    return NextResponse.json({ ok: true, resultado: j })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'erro' }, { status: 500 })
  }
}
