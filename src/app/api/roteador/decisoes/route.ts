import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'

// Decisões do roteador: agregados dos últimos N dias (padrão 7) + as 50 últimas
// linhas. A tabela não guarda texto da conversa — só rota, motivo, intenção e confiança.
export async function GET(req: NextRequest) {
  const dias = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get('dias')) || 7))
  const desde = new Date(Date.now() - dias * 86_400_000).toISOString()
  const db = createServerAdminClient()
  const { data, error } = await db
    .from('roteador_decisoes')
    .select('id, lead_id, canal, rota, motivo, permite, intencao, confianca, resultado, criado_em')
    .gte('criado_em', desde)
    .order('criado_em', { ascending: false })
    .limit(5000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Linha = NonNullable<typeof data>[number]
  const conta = (k: (r: Linha) => string | null) => {
    const m: Record<string, number> = {}
    for (const r of data ?? []) {
      const v = k(r) ?? '—'
      m[v] = (m[v] ?? 0) + 1
    }
    return m
  }
  return NextResponse.json({
    dias,
    total: data?.length ?? 0,
    porRota: conta((r) => r.rota),
    porResultado: conta((r) => r.resultado ?? 'guarda'),
    porIntencao: conta((r) => r.intencao),
    porMotivo: conta((r) => r.motivo),
    ultimas: (data ?? []).slice(0, 50),
  })
}
