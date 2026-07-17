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

  // Templates que o CRM mantém. retomada_lead = reengajamento de lead (fora das 24h);
  // alerta_transbordo = alerta operacional pro gestor quando a Sara pausa (UTILITY).
  const templates = [
    {
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
    },
    {
      name: 'alerta_transbordo',
      language: 'pt_BR',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text:
            'Atendimento humano necessário no CRM. Família: {{1}}. Telefone: {{2}}. Motivo: {{3}}. A Sara foi pausada — acesse o CRM para assumir a conversa.',
          example: { body_text: [['Maria Silva', '5568900000000', 'Pediu para falar com a coordenação']] },
        },
      ],
    },
    {
      name: 'retorno_visita',
      language: 'pt_BR',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text:
            'Olá, {{1}}! Aqui é a Sara, do Colégio Pequenos Guardiões. Foi uma alegria receber vocês na visita. 💙 Como foi a experiência? Ficou alguma dúvida em que eu possa ajudar?',
          example: { body_text: [['Maria']] },
        },
      ],
    },
  ]

  try {
    // Não recria os que já existem (a Meta rejeita nome duplicado).
    const existRes = await fetch(
      `https://graph.facebook.com/v21.0/${conta.waba_id}/message_templates?fields=name&limit=200`,
      { headers: { Authorization: `Bearer ${conta.token}` }, cache: 'no-store' }
    )
    const existJson = await existRes.json()
    const existentes = new Set<string>((existJson?.data || []).map((t: { name: string }) => t.name))

    const resultados: { name: string; ok: boolean; status?: string; erro?: string }[] = []
    for (const template of templates) {
      if (existentes.has(template.name)) {
        resultados.push({ name: template.name, ok: true, status: 'já existe' })
        continue
      }
      const r = await fetch(`https://graph.facebook.com/v21.0/${conta.waba_id}/message_templates`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${conta.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(template),
      })
      const j = await r.json()
      resultados.push(
        r.ok
          ? { name: template.name, ok: true, status: 'enviado' }
          : { name: template.name, ok: false, erro: j?.error?.message || 'falha' }
      )
    }

    const algumErro = resultados.some((x) => !x.ok)
    return NextResponse.json({ ok: !algumErro, resultados }, { status: algumErro ? 400 : 200 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'erro' }, { status: 500 })
  }
}
