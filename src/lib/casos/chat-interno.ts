/**
 * Conversa INTERNA da equipe com a IA sobre um Caso. A resposta é só para a
 * equipe: não envia nada à família, não muda o estado do Caso e não entra na
 * timeline. O prompt minimiza dados (sem telefone/e-mail). Limites por minuto e
 * por Caso; o turn_id único (do cliente) impede clique duplo pagar duas vezes.
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import { chamarModeloIA } from '@/lib/ia-credenciais'
import { ROTULO_ESTADO, type EstadoCaso } from './regras'
import type { Caso } from './servico'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export const LIMITE_POR_MINUTO = 5
export const LIMITE_POR_CASO = 50

export type ResultadoChat =
  | { ok: true; resposta: string }
  | { ok: false; status: 400 | 404 | 429 | 500; erro: string }

export async function perguntarSobreCaso(
  supabase: SupaAdmin,
  args: { casoId: string; pergunta: string; turnId: string; usuarioId: string }
): Promise<ResultadoChat> {
  const pergunta = args.pergunta.trim().slice(0, 2000)
  if (!pergunta || !args.turnId) return { ok: false, status: 400, erro: 'Escreva a pergunta.' }

  const { data } = await supabase.from('casos').select('*').eq('id', args.casoId).maybeSingle()
  const caso = data as Caso | null
  if (!caso) return { ok: false, status: 404, erro: 'Caso não encontrado.' }

  // Retry do mesmo turno: devolve a resposta já gerada, sem nova chamada.
  const { data: jaRespondido } = await supabase
    .from('caso_chat').select('conteudo').eq('turn_id', args.turnId).eq('papel', 'assistant').maybeSingle()
  if (jaRespondido) return { ok: true, resposta: jaRespondido.conteudo }

  const umMinuto = new Date(Date.now() - 60_000).toISOString()
  const [{ count: noMinuto }, { count: noCaso }] = await Promise.all([
    supabase.from('caso_chat').select('id', { count: 'exact', head: true }).eq('papel', 'user').eq('usuario_id', args.usuarioId).gt('criado_em', umMinuto),
    supabase.from('caso_chat').select('id', { count: 'exact', head: true }).eq('papel', 'user').eq('caso_id', caso.id),
  ])
  if ((noMinuto ?? 0) >= LIMITE_POR_MINUTO) return { ok: false, status: 429, erro: 'Muitas perguntas em sequência. Aguarde um minuto.' }
  if ((noCaso ?? 0) >= LIMITE_POR_CASO) return { ok: false, status: 429, erro: 'Limite de perguntas deste Caso atingido.' }

  const { error: insErr } = await supabase
    .from('caso_chat')
    .insert({ caso_id: caso.id, papel: 'user', conteudo: pergunta, usuario_id: args.usuarioId, turn_id: args.turnId })
  if (insErr) return { ok: false, status: 429, erro: 'Esta pergunta já está sendo respondida.' }

  const [{ data: msgs }, { data: eventos }, { data: anteriores }] = await Promise.all([
    supabase.from('mensagens').select('direcao, conteudo').eq('lead_id', caso.lead_id).order('criado_em', { ascending: false }).limit(20),
    supabase.from('caso_eventos').select('tipo, detalhe, criado_em').eq('caso_id', caso.id).order('criado_em'),
    supabase.from('caso_chat').select('papel, conteudo').eq('caso_id', caso.id).neq('turn_id', args.turnId).order('criado_em').limit(20),
  ])

  const conversa = (msgs ?? []).reverse()
    .filter((m: { conteudo: string | null }) => m.conteudo)
    .map((m: { direcao: string; conteudo: string }) => `${m.direcao === 'in' ? 'Família' : m.direcao === 'out_ia' ? 'IA' : 'Equipe'}: ${m.conteudo}`)
    .join('\n')
  const linhaTempo = (eventos ?? [])
    .map((e: { tipo: string; detalhe: Record<string, unknown> | null; criado_em: string }) =>
      `- ${new Date(e.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Rio_Branco' })}: ${e.tipo}${e.detalhe?.nota ? ` (${String(e.detalhe.nota)})` : ''}${e.detalhe?.informacao ? ` (${String(e.detalhe.informacao)})` : ''}`)
    .join('\n')

  const sistema = `Você ajuda a equipe do Colégio Pequenos Guardiões a decidir um Caso aberto pela IA de atendimento. Esta conversa é INTERNA: nada aqui vai para a família. Responda em português, curto e objetivo, sugerindo o que a equipe pode responder ou verificar. Se não souber algo da escola, diga que não sabe — não invente.

CASO #C${caso.numero} — ${caso.titulo}
Situação: ${ROTULO_ESTADO[caso.estado as EstadoCaso]} · Agente: ${caso.agente} · Assunto: ${caso.tipo}
Resumo: ${caso.resumo}
Por que a IA não resolveu: ${caso.motivo_bloqueio ?? '-'}
Nota da equipe: ${caso.nota_equipe ?? '-'}

Linha do tempo:
${linhaTempo || '-'}

Últimas mensagens da conversa com a família:
${conversa || '-'}`

  // Mesmo modelo/credencial do agente dono do Caso.
  const { data: cfg } = await supabase.from('config_ia').select('modelo, salomao_modelo').eq('id', 1).maybeSingle()
  const modelo = (caso.agente === 'salomao' ? cfg?.salomao_modelo?.trim() : null) || cfg?.modelo?.trim() || 'gpt-4o'

  try {
    const resposta = (await chamarModeloIA(caso.agente, {
      messages: [
        { role: 'system', content: sistema },
        ...(anteriores ?? []).map((m: { papel: 'user' | 'assistant'; conteudo: string }) => ({ role: m.papel, content: m.conteudo })),
        { role: 'user', content: pergunta },
      ],
      model: modelo,
      maxTokens: 600,
    }, supabase))?.trim() || 'Não consegui responder agora.'
    await supabase.from('caso_chat').insert({ caso_id: caso.id, papel: 'assistant', conteudo: resposta, usuario_id: args.usuarioId, turn_id: args.turnId })
    return { ok: true, resposta }
  } catch (e) {
    return { ok: false, status: 500, erro: e instanceof Error ? e.message : 'Erro ao consultar a IA.' }
  }
}
