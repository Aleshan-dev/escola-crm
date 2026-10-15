import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { arcaConfigurado } from '@/lib/arca'
import { evolutionConfigurado } from '@/lib/evolution'
import { dentroHorarioComercial, horaAcre } from '@/lib/followup-regras'
import { drenarSalomao } from '@/lib/salomao-dispatch'
import { registrarAlerta } from '@/lib/alertas'

// Drenagem do disparo em massa do Salomão (boletos + comunicados).
//
// POR QUE É UM CRON, e não o after() do gatilho:
// O gatilho "Acionar Salomão" agora só ENFILEIRA. Enviar a fila inteira na hora
// era uma rajada (o padrão que bloqueia o número). Aqui a fila é drenada em
// LEVAS PEQUENAS (MAX_ENVIOS_SALOMAO_POR_EXECUCAO), com 15–45s entre contatos, e
// SÓ dentro do horário comercial. A escola inteira sai ao longo do dia.
//
// HORÁRIO COMERCIAL: por decisão da direção (2026-09-03), o disparo em massa
// respeita 8h–20h (Acre) mesmo tendo partido de um clique — comunicado/boleto
// para a escola inteira não pode acordar família de madrugada. (Isto difere do
// cron de convites, onde o gatilho manual envia na hora; ali é 1 família, aqui
// são centenas.)
//
// Cron próprio, separado do /api/cron/followup (Sara): orçamentos de tempo
// diferentes não compartilham invocação — uma leva do Salomão com 45s de
// espaçamento estouraria o maxDuration:30 do follow-up e derrubaria a Sara.

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
  if (!dentroHorarioComercial(agora)) {
    return NextResponse.json({ skipped: `fora_do_horario_comercial (${horaAcre(agora)}h Acre)` })
  }

  if (!arcaConfigurado() || !(await evolutionConfigurado())) {
    return NextResponse.json({ skipped: 'arca_ou_evolution_nao_configurado' })
  }

  const supabase = createServerAdminClient()
  try {
    const { boletos, mensagens } = await drenarSalomao()
    const falhas = boletos.falhas + mensagens.falhas
    if (falhas > 0) {
      await registrarAlerta(
        supabase,
        'cron/salomao-dispatch',
        `Disparo Salomão: boletos ${boletos.enviados}/${boletos.pedidos}, ` +
          `comunicados ${mensagens.enviados}/${mensagens.pedidos}; ${falhas} falharam. ` +
          `Primeiros erros: ${[...boletos.erros, ...mensagens.erros].slice(0, 3).join(' | ')}`
      )
    }
    return NextResponse.json({ ok: true, hora_acre: horaAcre(agora), boletos, mensagens })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await registrarAlerta(supabase, 'cron/salomao-dispatch', `Falha na drenagem do Salomão: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
