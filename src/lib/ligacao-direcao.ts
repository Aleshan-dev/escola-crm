import type { createServerAdminClient } from '@/lib/supabase-server'
import { acreWallToUtc, ACRE_SHIFT_MS, labelAcre } from '@/lib/disponibilidade'
import { notificarGestor } from '@/lib/notificacoes'
import { registrarAlerta } from '@/lib/alertas'

// LIGAÇÃO DA DIREÇÃO (pedido da Direção, 26/11/2026).
// A equipe marca leads.convite_ligacao_em; o cron de follow-up manda UMA mensagem da
// Sara perguntando o melhor dia/horário (src/app/api/cron/followup). Quando a família
// crava dia + hora, a Sara preenche `agendar_ligacao` e este módulo grava a tarefa
// tipo 'ligacao' de 15 min — que o trigger do banco leva ao Google Agenda com a duração
// de crm.tarefas.duracao_min.

type Supabase = ReturnType<typeof createServerAdminClient>

export const LIGACAO_DURACAO_MIN = 15
const HORA_MIN = 8 * 60 // 08:00
const HORA_MAX = 17 * 60 + 45 // última ligação começa 17:45 e termina 18:00
const ANTECEDENCIA_MS = 60 * 60 * 1000

/** Instrução do toque único de convite (cron de follow-up). A Sara redige com o histórico. */
export function promptConviteLigacao(nomeResponsavel: string | null | undefined): string {
  const nome = (nomeResponsavel || '').trim() || 'a família'
  return `CONVITE PARA UMA LIGAÇÃO DA DIREÇÃO — mensagem única pedida pela equipe da escola.
Escreva UMA mensagem curta (no máximo 2 balões curtos), calorosa e pessoal para ${nome}:
- Se a conversa esfriou há dias, peça licença por reaparecer.
- Diga que a Direção do Colégio Pequenos Guardiões gostaria de fazer uma ligação rápida, de uns 15 minutinhos, para conversar pessoalmente sobre a vaga para 2027 (cite o nome da criança SE ele estiver no histórico ou na ficha; NUNCA invente nome) e tirar as dúvidas que ficaram.
- PERGUNTE qual é o melhor dia e horário para ela receber a ligação (segunda a sexta, entre 8h e 18h). NÃO proponha horários prontos.
- NÃO cite valores, descontos, condições especiais nem promoções. NÃO ofereça visita nesta mensagem.
- Deixe uma saída leve: se não for um bom momento, tudo bem.
- NÃO preencha "agendar_ligacao" nem "agendar_visita" neste turno (a família ainda não respondeu).`
}

export type HorarioLigacao =
  | { ok: true; utc: Date }
  | { ok: false; motivo: 'formato' | 'fim_de_semana' | 'fora_do_horario' | 'passado' | 'dia_fechado' }

/** Valida dia/hora (parede de Acre) pedidos pela família. Pura — testada em ligacao-direcao.test.ts. */
export function validarHorarioLigacao(
  dataAcre: string,
  horaAcre: string,
  agoraMs: number,
  diasFechados: ReadonlySet<string> = new Set()
): HorarioLigacao {
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dataAcre)
  const mh = /^(\d{1,2}):(\d{2})$/.exec(horaAcre)
  if (!md || !mh) return { ok: false, motivo: 'formato' }
  const [y, mo, d] = [Number(md[1]), Number(md[2]), Number(md[3])]
  const [h, mi] = [Number(mh[1]), Number(mh[2])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return { ok: false, motivo: 'formato' }
  const utc = acreWallToUtc(y, mo - 1, d, h, mi)
  const parede = new Date(utc.getTime() + ACRE_SHIFT_MS)
  // Data inexistente (ex.: 31/11) rola para outro dia: recusa.
  if (parede.getUTCDate() !== d || parede.getUTCMonth() !== mo - 1) return { ok: false, motivo: 'formato' }
  const dow = parede.getUTCDay()
  if (dow === 0 || dow === 6) return { ok: false, motivo: 'fim_de_semana' }
  const minutos = h * 60 + mi
  if (minutos < HORA_MIN || minutos > HORA_MAX) return { ok: false, motivo: 'fora_do_horario' }
  if (utc.getTime() < agoraMs + ANTECEDENCIA_MS) return { ok: false, motivo: 'passado' }
  if (diasFechados.has(dataAcre)) return { ok: false, motivo: 'dia_fechado' }
  return { ok: true, utc }
}

const MOTIVO_PT: Record<Exclude<HorarioLigacao, { ok: true }>['motivo'], string> = {
  formato: 'data/hora inválida',
  fim_de_semana: 'cai no fim de semana',
  fora_do_horario: 'fora do horário (08:00–17:45)',
  passado: 'horário já passou ou com menos de 1h de antecedência',
  dia_fechado: 'dia fechado no calendário escolar',
}

/**
 * Grava a ligação pedida pela família: move a ligação aberta (reagendamento) ou cria
 * uma nova de 15 min, zera o convite e avisa o gestor. Horário inválido não grava nada
 * e abre um alerta para a equipe acertar com a família.
 */
export async function agendarLigacaoDirecao(
  supabase: Supabase,
  args: { leadId: string; nome: string | null; dataAcre: string; horaAcre: string; agoraMs?: number }
): Promise<{ ok: boolean; tarefaId?: string; motivo?: string }> {
  const agoraMs = args.agoraMs ?? Date.now()
  const nome = (args.nome || '').trim() || 'Família'

  let fechados = new Set<string>()
  try {
    const { data } = await supabase.rpc('dias_fechados', { p_de: args.dataAcre, p_ate: args.dataAcre })
    fechados = new Set(((data ?? []) as { dia?: string; data?: string }[]).map((r) => String(r.dia ?? r.data ?? '').slice(0, 10)))
  } catch {
    // Falha de leitura do calendário não impede agendar (mesma política da agenda de visitas).
  }

  const v = validarHorarioLigacao(args.dataAcre, args.horaAcre, agoraMs, fechados)
  if (!v.ok) {
    await registrarAlerta(
      supabase,
      'sara/ligacao-direcao',
      `📞 ${nome} pediu a ligação da Direção para ${args.dataAcre} ${args.horaAcre}, mas o horário não foi agendado (${MOTIVO_PT[v.motivo]}). Combine outro horário com a família.`,
      { tipo: 'engajamento', leadId: args.leadId }
    )
    return { ok: false, motivo: v.motivo }
  }

  const iso = v.utc.toISOString()
  const { data: aberta } = await supabase
    .from('tarefas')
    .select('id')
    .eq('lead_id', args.leadId)
    .eq('tipo', 'ligacao')
    .eq('concluida', false)
    .neq('status', 'cancelada')
    .gte('data_hora', new Date(agoraMs).toISOString())
    .order('data_hora', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>()

  let tarefaId: string | undefined
  if (aberta) {
    const { error } = await supabase
      .from('tarefas')
      .update({ data_hora: iso, duracao_min: LIGACAO_DURACAO_MIN, status: 'agendada' })
      .eq('id', aberta.id)
    if (error) throw error
    tarefaId = aberta.id
  } else {
    const { data: nova, error } = await supabase
      .from('tarefas')
      .insert({
        lead_id: args.leadId,
        titulo: `📞 Ligação Direção — ${nome} (15 min)`,
        tipo: 'ligacao',
        status: 'agendada',
        data_hora: iso,
        duracao_min: LIGACAO_DURACAO_MIN,
        descricao: 'Ligação de 15 min com a Direção, horário escolhido pela família no WhatsApp (Sara).',
      })
      .select('id')
      .single<{ id: string }>()
    if (error) throw error
    tarefaId = nova.id
  }

  await supabase
    .from('leads')
    .update({ convite_ligacao_em: null, proxima_acao: 'Ligação da Direção', data_proxima_acao: iso })
    .eq('id', args.leadId)

  await notificarGestor(
    supabase,
    'visita',
    `📞 *Ligação da Direção ${aberta ? 'remarcada' : 'agendada'}* — ${nome}: ${labelAcre(v.utc)} (15 min). Já está na agenda.`
  ).catch(() => {})

  return { ok: true, tarefaId }
}
