import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { rodarAuditoria } from '@/lib/auditoria'
import { notificarGestor } from '@/lib/notificacoes'
import { registrarAlerta } from '@/lib/alertas'

// Auditoria diária do atendimento da Sara. Aceita o cron da Vercel (x-vercel-cron)
// ou o Bearer CRON_SECRET. Roda a análise, grava o relatório e avisa o gestor.
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const autorizado =
    req.headers.get('x-vercel-cron') === '1' ||
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (!autorizado) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const supabase = createServerAdminClient()
  try {
    const { id } = await rodarAuditoria(supabase)
    if (!id) return NextResponse.json({ ok: true, vazio: true })

    const { data: a } = await supabase
      .from('auditorias_sara')
      .select('nota_geral, conversas_analisadas, resumo, sugestoes')
      .eq('id', id)
      .single()

    if (a) {
      const sugestoes = (a.sugestoes as string[] | null) || []
      const top = sugestoes.slice(0, 3).map((s, i) => `${i + 1}. ${s}`).join('\n')
      await notificarGestor(
        supabase,
        'transbordo',
        `🔎 *Auditoria da Sara (24h)*\n` +
          `Nota: ${a.nota_geral ?? '—'}/100 · ${a.conversas_analisadas} conversa(s)\n\n` +
          `${a.resumo || ''}\n\n` +
          (top ? `Sugestões:\n${top}\n\n` : '') +
          `Detalhes no CRM → Auditoria.`
      )
    }

    return NextResponse.json({ ok: true, id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('auditoria-sara falhou:', msg)
    await registrarAlerta(supabase, 'cron/auditoria-sara', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
