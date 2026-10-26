import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { auditarPendentes, medirRegrasAtivas } from '@/lib/auditor'
import { registrarAlerta } from '@/lib/alertas'

// ADR-006 Nível 1: roda o Auditor Cognitivo sobre conversas de captação ainda não
// auditadas e grava as sugestões (Aplicar/Rejeitar na tela /auditoria).
// Aciona por cron (x-vercel-cron) OU manualmente (Bearer CRON_SECRET / botão no CRM).

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const vercelCron = req.headers.get('x-vercel-cron')
  let autenticado = vercelCron === '1' || (!!cronSecret && authHeader === `Bearer ${cronSecret}`)

  // Botão "Auditar agora" no CRM: aceita também usuário logado.
  if (!autenticado) {
    const sb = await createClient()
    const { data } = await sb.auth.getUser()
    autenticado = !!data.user
  }
  if (!autenticado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const supabase = createServerAdminClient()

  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50)

  try {
    const resultados = await auditarPendentes(supabase, limit)
    const auditadas = resultados.filter((r) => typeof r.score === 'number')
    const regrasMedidas = await medirRegrasAtivas(supabase)
    return NextResponse.json({
      ok: true,
      auditadas: auditadas.length,
      erros: resultados.filter((r) => r.erro).length,
      regras_medidas: regrasMedidas,
      resultados,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erro desconhecido'
    console.error('Auditor falhou:', msg)
    await registrarAlerta(supabase, 'cron/auditor', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// Permite acionar via POST também (ex.: botão "Auditar agora" na tela /auditoria).
export async function POST(req: NextRequest) {
  return GET(req)
}
