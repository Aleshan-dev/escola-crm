import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { convitesConfigurado, drenarConvites } from '@/lib/convites'
import { evolutionConfigurado } from '@/lib/evolution'
import { dentroHorarioComercial, horaAcre } from '@/lib/followup-regras'
import { registrarAlerta } from '@/lib/alertas'

// Varredura da fila de convites de pré-matrícula.
//
// Por que existe, se o Arca já tem o botão: (1) convite criado sem clique no
// botão ficaria preso para sempre; (2) o gatilho processa no máximo 50 por leva
// — o resto precisa de quem venha buscar; (3) convite que caiu em `pendente`
// porque a função morreu no meio volta aqui sozinho.
//
// Cron separado do /api/cron/followup de propósito: aquele tem maxDuration 30 e
// teto de 6 envios: um lote de 50 convites o estouraria e derrubaria os
// follow-ups da Sara junto. Fluxos com orçamento de tempo diferente não
// compartilham invocação.

export const maxDuration = 300

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const vercelCron = req.headers.get('x-vercel-cron')
  const autenticado = vercelCron === '1' || (!!cronSecret && authHeader === `Bearer ${cronSecret}`)
  if (!autenticado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const agora = Date.now()
  // Diferente do gatilho manual: ali a direção clicou e decidiu a hora; aqui é
  // o robô, e ninguém quer o Salomão acordando família às 3h da manhã.
  if (!dentroHorarioComercial(agora)) {
    return NextResponse.json({ skipped: `fora_do_horario_comercial (${horaAcre(agora)}h Acre)` })
  }

  if (!convitesConfigurado() || !(await evolutionConfigurado())) {
    return NextResponse.json({ skipped: 'convites_ou_evolution_nao_configurado' })
  }

  const supabase = createServerAdminClient()
  try {
    const r = await drenarConvites()
    if (r.falhas > 0) {
      await registrarAlerta(
        supabase,
        'cron/convites',
        `Convites de matrícula: ${r.enviados} enviados, ${r.falhas} falharam (de ${r.reivindicados}). ` +
          `Primeiros erros: ${r.erros.slice(0, 3).join(' | ')}`
      )
    }
    return NextResponse.json({ ok: true, hora_acre: horaAcre(agora), ...r })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await registrarAlerta(supabase, 'cron/convites', `Falha na varredura de convites: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
