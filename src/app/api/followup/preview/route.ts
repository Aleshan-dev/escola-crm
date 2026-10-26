import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { gerarRespostaSara } from '@/lib/sara'
import { janelaAberta } from '@/lib/janela'
import { canalDeSaida } from '@/lib/whatsapp-cloud'
import {
  triggerPorColuna,
  promptPorTrigger,
  promptPosVisitaPorToque,
  POS_VISITA_MAX_TOQUES,
  POS_VISITA_TOQUES_HORAS,
} from '@/lib/followup-regras'
import { dividirEmBaloes } from '@/lib/atendimento'

// PREVIEW (dry-run) do follow-up para UM lead — sem enviar nada.
// Mostra o gatilho, a mensagem que a Sara geraria, se a janela de 24h está
// aberta/fechada e a decisão que o cron tomaria (enviar pelo Cloud × criar alerta
// manual). Serve para validar o fluxo em 1 lead ANTES de ligar a flag global.
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const auth = await createClient()
  const { data: { user } } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id } = await req.json()
  if (!lead_id) return NextResponse.json({ error: 'lead_id obrigatório' }, { status: 400 })

  const supabase = createServerAdminClient()
  const { data: lead } = await supabase
    .from('leads')
    .select('id, followup_count, entrou_coluna_em, coluna:colunas(nome, followup_max, followup_intervalo_horas), familia:familias(nome_responsavel, telefone, whatsapp_phone_number_id)')
    .eq('id', lead_id)
    .single()
  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const col = lead.coluna as unknown as { nome: string; followup_max: number; followup_intervalo_horas: number | null } | null
  const fam = lead.familia as unknown as { nome_responsavel: string | null; telefone: string | null; whatsapp_phone_number_id: string | null } | null
  const tel = fam?.telefone
  if (!col || !tel) {
    return NextResponse.json({ error: 'Lead sem coluna ou telefone' }, { status: 400 })
  }
  if (col.followup_intervalo_horas == null) {
    return NextResponse.json({
      ok: true,
      etapa_sem_followup: true,
      coluna: col.nome,
      nome: fam?.nome_responsavel ?? null,
      telefone: tel,
    })
  }

  const trigger = triggerPorColuna(col.nome)
  let count = lead.followup_count ?? 0
  let followupMax = col.followup_max
  let marco: string | undefined
  let prompt: string

  if (trigger === 'followup_pos_visita') {
    // Pós-visita: o "próximo toque" vem do cronograma (D0/D3/D7/D10/D14), não do backoff.
    const entrouColunaMs = (lead as { entrou_coluna_em?: string | null }).entrou_coluna_em
      ? new Date((lead as { entrou_coluna_em: string }).entrou_coluna_em).getTime()
      : 0
    const { count: jaEnviados } = await supabase
      .from('followup_log')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', lead_id)
      .in('trigger', ['followup_pos_visita', 'followup_pos_visita_alerta'])
      .gte('criado_em', new Date(entrouColunaMs || 0).toISOString())
    const toque = Math.min(jaEnviados ?? 0, POS_VISITA_MAX_TOQUES - 1)
    count = jaEnviados ?? 0
    followupMax = POS_VISITA_MAX_TOQUES
    marco = `toque ${(jaEnviados ?? 0) + 1} de ${POS_VISITA_MAX_TOQUES} · D${Math.round(POS_VISITA_TOQUES_HORAS[toque] / 24)}`
    prompt = promptPosVisitaPorToque(fam?.nome_responsavel ?? 'a família', jaEnviados ?? 0) ?? ''
  } else {
    prompt = promptPorTrigger(trigger, fam?.nome_responsavel ?? 'a família', count + 1) ?? ''
  }

  // Instrumentação: as MESMAS anotações que a Sara carrega internamente, para
  // conferência na tela ("a Sara realmente recebeu estas notas?").
  const { data: anot } = await supabase
    .from('anotacoes')
    .select('conteudo, criado_em')
    .eq('lead_id', lead_id)
    .order('criado_em', { ascending: false })
    .limit(10)

  // Gera a mensagem da Sara e checa a janela — SEM enviar.
  const sara = await gerarRespostaSara(lead_id, undefined, undefined, prompt)
  const texto = sara.resposta ?? ''
  // Janela de 24h só vale se a saída real for a Cloud (mesma regra do cron).
  const canal = await canalDeSaida(tel, fam?.whatsapp_phone_number_id)
  const aberta = canal !== 'cloud' || (await janelaAberta(supabase, tel))

  return NextResponse.json({
    ok: true,
    nome: fam?.nome_responsavel ?? null,
    telefone: tel,
    coluna: col.nome,
    trigger,
    followup_count: count,
    followup_max: followupMax,
    marco,
    janela_aberta: aberta,
    canal,
    decisao: aberta ? (canal === 'cloud' ? 'enviaria_cloud' : 'enviaria_waha') : 'criaria_alerta_manual',
    mensagem: texto,
    baloes: dividirEmBaloes(texto),
    anotacoes: (anot as { conteudo: string; criado_em: string }[] | null) ?? [],
  })
}
