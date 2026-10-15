import { NextResponse, type NextRequest } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { registrarAlerta } from '@/lib/alertas'
import { dentroHorarioComercial } from '@/lib/followup-regras'
import { executarFollowup } from '../followup/route'

// ============================================================================
// HEARTBEAT + GATILHO EM PROCESSO do motor de follow-up.
//
// Origem (ADR-008): em 23/07 e 10/09 o cron dedicado /api/cron/followup da Vercel
// parou de ser agendado sozinho e ninguém foi avisado — um cron que não roda não
// emite nada. A defesa era o heartbeat (cron separado, historicamente confiável)
// ACIONAR o follow-up. Antes isso era um fetch HTTP para a própria app; esse salto
// dependia de NEXT_PUBLIC_APP_URL (que não existe em produção -> caía no domínio
// .vercel.app), de CRON_SECRET e de passar pela proteção SSO — frágil, e foi por
// isso que a rede de segurança não pegou os ~14 dias mudos de 10-24/09.
//
// AGORA o heartbeat RODA o follow-up EM PROCESSO (executarFollowup), sem salto de
// rede: se este cron rodar, o motor roda. O alarme dispara só quando RODAR o motor
// falha de fato — não mais por "silêncio há Xh", que com backoff de 24-48h e baixo
// volume era falso positivo constante (o motor ficava são, só não tinha nada devido).
//
// LIMITE HONESTO: se a Vercel parar TODO o agendamento, o próprio heartbeat não roda
// e não há aviso — só um dead-man switch EXTERNO cobriria isso (rejeitado no ADR-008).
// ============================================================================

// Roda o follow-up em processo; folga de tempo para o loop + pacing (jitter entre envios).
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const autorizado =
    req.headers.get('x-vercel-cron') === '1' ||
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (!autorizado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const agora = Date.now()
  const supabase = createServerAdminClient()
  try {
    // O follow-up está LIGADO? Se não, o heartbeat fica dormente (não aciona nem alarma).
    const { data: cfg } = await supabase
      .from('config_ia')
      .select('followup_ativo')
      .eq('id', 1)
      .maybeSingle<{ followup_ativo: boolean }>()
    if (!cfg?.followup_ativo) {
      return NextResponse.json({ ok: true, pulado: 'followup_desligado' })
    }

    // Fora do horário comercial o motor não envia — nem tenta (evita ruído noturno).
    if (!dentroHorarioComercial(agora)) {
      return NextResponse.json({ ok: true, pulado: 'fora_horario_comercial' })
    }

    // GATILHO EM PROCESSO: roda o motor direto (rede de segurança contra o cron
    // dedicado da Vercel morrer sozinho). Alarme só se ISSO falhar.
    try {
      const resumo = await executarFollowup(agora)
      return NextResponse.json({ ok: true, followup_ok: true, followup: resumo })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('heartbeat -> executarFollowup falhou:', msg)
      await registrarAlerta(
        supabase,
        'cron/heartbeat',
        `Follow-up FALHOU ao ser acionado em processo pelo heartbeat: ${msg}. Motor possivelmente quebrado (ADR-008).`,
        { tipo: 'sistema' }
      )
      return NextResponse.json({ ok: false, followup_ok: false, erro: msg }, { status: 500 })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('heartbeat falhou:', msg)
    // O próprio watchdog falhar também é digno de alerta.
    await registrarAlerta(supabase, 'cron/heartbeat', `Heartbeat falhou: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
