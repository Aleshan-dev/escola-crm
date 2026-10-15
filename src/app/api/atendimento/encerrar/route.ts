import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Encerrar / reabrir o atendimento de um lead.
//
// "Encerrar" NÃO pausa a Sara: apenas tira o lead do FOLLOW-UP proativo
// (o cron filtra followup_encerrado_em IS NULL). A Sara continua REATIVA — se a
// família voltar a mandar mensagem, ela responde normalmente. Reabrir devolve o
// lead ao follow-up. Fonte única de verdade, chamada pelo chat e pelo modal do lead.
export async function POST(req: NextRequest) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id, acao, motivo } = await req.json().catch(() => ({}))
  if (!lead_id || (acao !== 'encerrar' && acao !== 'reabrir')) {
    return NextResponse.json({ error: "lead_id e acao ('encerrar'|'reabrir') são obrigatórios" }, { status: 400 })
  }

  const admin = createServerAdminClient()

  const { data: lead, error: errLead } = await admin
    .from('leads')
    .select('id, familia:familias(nome_responsavel)')
    .eq('id', lead_id)
    .maybeSingle()
  if (errLead || !lead) {
    return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })
  }
  const nome =
    (lead as { familia?: { nome_responsavel?: string } | null }).familia?.nome_responsavel || 'Família'

  if (acao === 'encerrar') {
    const { error } = await admin
      .from('leads')
      .update({
        followup_encerrado_em: new Date().toISOString(),
        followup_encerrado_motivo: (typeof motivo === 'string' && motivo.trim()) ? motivo.trim() : null,
        // Limpa a bandeira de sugestão: o gestor já decidiu.
        sugestao_encerramento: false,
      })
      .eq('id', lead_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await admin.from('eventos_timeline').insert({
      lead_id,
      tipo: 'encerramento',
      descricao:
        'Atendimento encerrado pelo gestor — lead retirado do follow-up automático' +
        (typeof motivo === 'string' && motivo.trim() ? `. Motivo: ${motivo.trim()}` : '') +
        '. A Sara ainda responde se a família voltar a escrever.',
    })

    return NextResponse.json({ ok: true, encerrado: true })
  }

  // acao === 'reabrir'
  const { error } = await admin
    .from('leads')
    .update({ followup_encerrado_em: null, followup_encerrado_motivo: null })
    .eq('id', lead_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await admin.from('eventos_timeline').insert({
    lead_id,
    tipo: 'encerramento',
    descricao: `Atendimento reaberto pelo gestor (${nome}) — lead volta ao follow-up automático.`,
  })

  return NextResponse.json({ ok: true, encerrado: false })
}
