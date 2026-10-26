/**
 * CASOS — serviço de domínio (I/O). Abre, transiciona e cancela Casos; avisa a
 * equipe por WhatsApp; executa os comandos #C. Toda mutação passa pelas RPCs
 * atômicas crm.caso_abrir / crm.caso_transicionar (estado esperado + evento numa
 * instrução só: corrida ou ação repetida devolve conflito, nunca sobrescreve).
 *
 * O turno de retorno da IA (comunicar a decisão à família) está em retorno.ts.
 */
import { createHash } from 'crypto'
import type { createServerAdminClient } from '@/lib/supabase-server'
import { enviarAvisoInterno } from '@/lib/canais/enviar'
import {
  ESTADOS_ABERTOS, TRANSICAO_EQUIPE, validarNota,
  type AcaoEquipe, type AgenteCaso, type EstadoCaso, type OrigemCaso, type PedidoAbertura,
} from './regras'
import { interpretarRespostaEquipe, stanzaDe, type ComandoCaso } from './comandos'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export interface Caso {
  id: string
  numero: number
  lead_id: string
  familia_id: string | null
  agente: AgenteCaso
  titulo: string
  resumo: string
  motivo_bloqueio: string | null
  tipo: string
  contexto: string | null
  origem: OrigemCaso
  estado: EstadoCaso
  nota_equipe: string | null
  cobrancas: number
  retorno_pendente_em: string | null
  criado_em: string
  atualizado_em: string
  fechado_em: string | null
  fechado_por: string | null
}

export interface ConfigCasos {
  ativo: boolean
  telefoneAviso: string | null
  comandosWhatsapp: boolean
  guardaPromessa: string
}

export async function lerConfigCasos(supabase: SupaAdmin): Promise<ConfigCasos> {
  const { data } = await supabase
    .from('config_ia')
    .select('casos_ativo, casos_telefone_aviso, casos_comandos_whatsapp, casos_guarda_promessa, telefone_transbordo')
    .eq('id', 1)
    .maybeSingle()
  return {
    ativo: data?.casos_ativo === true,
    telefoneAviso: data?.casos_telefone_aviso?.trim() || data?.telefone_transbordo?.trim() || null,
    comandosWhatsapp: data?.casos_comandos_whatsapp === true,
    guardaPromessa: data?.casos_guarda_promessa ?? 'log',
  }
}

export async function casoAbertoDoLead(supabase: SupaAdmin, leadId: string): Promise<Caso | null> {
  const { data } = await supabase
    .from('casos')
    .select('*')
    .eq('lead_id', leadId)
    .in('estado', ESTADOS_ABERTOS)
    .maybeSingle()
  return (data as Caso | null) ?? null
}

/** Contexto do Caso montado do histórico REAL (nunca aceito livre do modelo). */
async function montarContexto(supabase: SupaAdmin, leadId: string): Promise<string> {
  const { data } = await supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(10)
  return (data ?? [])
    .reverse()
    .filter((m: { conteudo: string | null }) => m.conteudo)
    .map((m: { direcao: string; conteudo: string }) => `${m.direcao === 'in' ? 'Família' : m.direcao === 'out_ia' ? 'IA' : 'Equipe'}: ${m.conteudo}`)
    .join('\n')
    .slice(0, 4000)
}

/**
 * Abre um Caso e avisa a equipe. Devolve null se o lead já tem um Caso aberto
 * (índice único parcial no banco) — o chamador segue a conversa normalmente.
 */
export async function abrirCaso(
  supabase: SupaAdmin,
  args: { leadId: string; agente: AgenteCaso; pedido: PedidoAbertura; origem: OrigemCaso }
): Promise<Caso | null> {
  const { data: lead } = await supabase.from('leads').select('familia_id').eq('id', args.leadId).maybeSingle()
  const contexto = await montarContexto(supabase, args.leadId)
  const { data, error } = await supabase.rpc('caso_abrir', {
    p_lead_id: args.leadId,
    p_familia_id: lead?.familia_id ?? null,
    p_agente: args.agente,
    p_titulo: args.pedido.titulo,
    p_resumo: args.pedido.resumo,
    p_motivo: args.pedido.motivo,
    p_tipo: args.pedido.tipo,
    p_contexto: contexto,
    p_origem: args.origem,
  })
  if (error) {
    console.error('[casos] caso_abrir falhou:', error.message)
    return null
  }
  const caso = (data as Caso | null)?.id ? (data as Caso) : null
  if (!caso) return null

  await supabase.from('eventos_timeline').insert({
    lead_id: args.leadId,
    tipo: 'anotacao',
    descricao: `${nomeAgente(caso.agente)} abriu o Caso #C${caso.numero} para a equipe: ${caso.titulo}`,
  })
  await avisarEquipe(supabase, caso, 'abertura', 'abertura')
  return caso
}

/** Transição condicionada ao estado esperado. null = conflito (o estado já mudou). */
export async function transicionar(
  supabase: SupaAdmin,
  args: {
    casoId: string; de: EstadoCaso[]; para: EstadoCaso; evento: string; ator: string
    nota?: string | null; retorno?: boolean; detalhe?: Record<string, unknown>
  }
): Promise<Caso | null> {
  const { data, error } = await supabase.rpc('caso_transicionar', {
    p_caso_id: args.casoId,
    p_de: args.de,
    p_para: args.para,
    p_evento: args.evento,
    p_ator: args.ator,
    p_nota: args.nota ?? null,
    p_retorno: args.retorno ?? false,
    p_detalhe: args.detalhe ?? {},
  })
  if (error) {
    console.error('[casos] caso_transicionar falhou:', error.message)
    return null
  }
  return (data as Caso | null)?.id ? (data as Caso) : null
}

export type ResultadoAcao =
  | { ok: true; caso: Caso; retorno: boolean }
  | { ok: false; status: 400 | 404 | 409 | 500; erro: string }

/**
 * Ação da equipe (tela ou WhatsApp). Só a partir de 'aguardando_equipe'.
 * Concluir/pedir info marcam retorno_pendente_em: o chamador dispara
 * executarRetornoCaso (retorno.ts) — e o heartbeat refaz se o disparo morrer.
 * Escalar faz PRIMEIRO o handoff; se ele falhar, o Caso continua aberto.
 */
export async function acaoEquipe(
  supabase: SupaAdmin,
  args: { casoId: string; acao: AcaoEquipe; nota: unknown; ator: string }
): Promise<ResultadoAcao> {
  const v = validarNota(args.acao, args.nota)
  if (!v.ok) return { ok: false, status: 400, erro: v.erro }

  const { data: atual } = await supabase.from('casos').select('*').eq('id', args.casoId).maybeSingle()
  if (!atual) return { ok: false, status: 404, erro: 'Caso não encontrado.' }
  const caso = atual as Caso
  if (caso.estado !== 'aguardando_equipe') {
    return { ok: false, status: 409, erro: 'Este Caso já foi respondido ou fechado.' }
  }

  const t = TRANSICAO_EQUIPE[args.acao]

  if (args.acao === 'escalar') {
    const { error } = await supabase
      .from('leads')
      .update({
        precisa_atendimento_humano: true,
        ia_ativa: false,
        motivo_transbordo: `Caso #C${caso.numero}: ${caso.titulo}`,
        transbordo_em: new Date().toISOString(),
      })
      .eq('id', caso.lead_id)
    if (error) return { ok: false, status: 500, erro: 'Não foi possível passar para humano. O Caso continua aberto.' }
    await supabase.from('eventos_timeline').insert({
      lead_id: caso.lead_id,
      tipo: 'status_ia',
      descricao: `IA pausada: a equipe passou o Caso #C${caso.numero} para atendimento humano.${v.nota ? ` Obs.: ${v.nota}` : ''}`,
    })
  }

  const novo = await transicionar(supabase, {
    casoId: caso.id, de: ['aguardando_equipe'], para: t.para, evento: t.evento,
    ator: args.ator, nota: v.nota, retorno: t.retorno,
  })
  if (!novo) return { ok: false, status: 409, erro: 'Este Caso já foi respondido ou fechado.' }
  return { ok: true, caso: novo, retorno: t.retorno }
}

/**
 * A família respondeu o que a equipe pediu (`atualizar_caso` da IA). Volta para a
 * equipe e REAVISA — sem isso o Caso voltaria à fila em silêncio.
 */
export async function atualizarPelaFamilia(
  supabase: SupaAdmin,
  args: { leadId: string; agente: AgenteCaso; informacao: string }
): Promise<Caso | null> {
  const aberto = await casoAbertoDoLead(supabase, args.leadId)
  if (!aberto || aberto.estado !== 'aguardando_familia') return null
  const novo = await transicionar(supabase, {
    casoId: aberto.id, de: ['aguardando_familia'], para: 'aguardando_equipe',
    evento: 'familia_respondeu', ator: args.agente, detalhe: { informacao: args.informacao.slice(0, 4000) },
  })
  if (novo) await avisarEquipe(supabase, novo, 'familia_respondeu', `familia:${novo.atualizado_em}`, args.informacao)
  return novo
}

/** Cancela o Caso aberto do lead (opt-out, arquivamento). Sem aviso à equipe. */
export async function cancelarCasoDoLead(supabase: SupaAdmin, leadId: string, motivo: string): Promise<void> {
  const aberto = await casoAbertoDoLead(supabase, leadId)
  if (!aberto) return
  await transicionar(supabase, {
    casoId: aberto.id, de: ESTADOS_ABERTOS, para: 'cancelado', evento: 'cancelado',
    ator: 'sistema', detalhe: { motivo },
  })
}

// ── Aviso por WhatsApp à equipe ─────────────────────────────────────────────

export type TipoAviso = 'abertura' | 'cobranca' | 'familia_respondeu' | 'familia_sem_resposta' | 'teste'

const nomeAgente = (a: AgenteCaso) => (a === 'salomao' ? 'Salomão' : 'Sara')
const mascarar = (tel: string) => `***${tel.replace(/\D/g, '').slice(-4)}`

export function textoAviso(
  caso: Pick<Caso, 'numero' | 'agente' | 'titulo' | 'resumo' | 'motivo_bloqueio' | 'nota_equipe' | 'criado_em'>,
  tipo: TipoAviso,
  opts: { familia?: string | null; extra?: string | null; comandos: boolean }
): string {
  const cod = `#C${caso.numero}`
  const fam = opts.familia ? `\nFamília: ${opts.familia}` : ''
  const ajuda = opts.comandos
    ? `\n\nPara responder, cite esta mensagem (responder no WhatsApp) e escreva a resposta para a família.\n` +
      `Começando com "pedir", a IA pergunta à família; "humano" passa o atendimento para uma pessoa.\n` +
      `Ou use o código: ${cod} ok <resposta> | ${cod} pedir <pergunta> | ${cod} humano`
    : '\n\nResponda pelo CRM, na tela Casos.'
  switch (tipo) {
    case 'abertura':
    case 'teste':
      return `📌 *Caso ${cod}* (${nomeAgente(caso.agente)}) — ${caso.titulo}${fam}\n\n${caso.resumo}` +
        (caso.motivo_bloqueio ? `\nPor que não resolveu: ${caso.motivo_bloqueio}` : '') +
        `\n\nA IA segue falando com a família enquanto vocês decidem.${ajuda}`
    case 'cobranca': {
      const horas = Math.round((Date.now() - new Date(caso.criado_em).getTime()) / 3_600_000)
      return `⏰ *Caso ${cod} esperando a equipe* (aberto há ${horas}h) — ${caso.titulo}${fam}\n\n${caso.resumo}${ajuda}`
    }
    case 'familia_respondeu':
      return `💬 *Caso ${cod}* — a família respondeu o que vocês pediram.${fam}\nPedido: ${caso.nota_equipe ?? '-'}\nResposta: ${opts.extra ?? '-'}${ajuda}`
    case 'familia_sem_resposta':
      return `⌛ *Caso ${cod}* — a família não respondeu ao pedido "${caso.nota_equipe ?? '-'}" em 48h. O Caso voltou para a equipe.${fam}${ajuda}`
  }
}

/**
 * Envia o aviso UMA vez por (caso, chave): a linha em caso_avisos é reivindicada
 * ANTES do envio (unique), então execuções concorrentes não duplicam. Falha do
 * envio fica registrada como 'falhou' e nunca derruba o atendimento.
 */
export async function avisarEquipe(
  supabase: SupaAdmin,
  caso: Caso,
  tipo: TipoAviso,
  chave: string,
  extra?: string | null
): Promise<'enviado' | 'duplicado' | 'sem_telefone' | 'falhou'> {
  try {
    const cfg = await lerConfigCasos(supabase)
    if (!cfg.telefoneAviso) return 'sem_telefone'

    const { data: fam } = caso.familia_id
      ? await supabase.from('familias').select('nome_responsavel').eq('id', caso.familia_id).maybeSingle()
      : { data: null }
    const texto = textoAviso(caso, tipo, { familia: fam?.nome_responsavel, extra, comandos: cfg.comandosWhatsapp })

    const { data: claim, error: claimErr } = await supabase
      .from('caso_avisos')
      .insert({
        caso_id: caso.id, chave, tipo,
        destino_mascarado: mascarar(cfg.telefoneAviso),
        corpo_hash: createHash('sha256').update(texto).digest('hex'),
        tentativas: 1,
      })
      .select('id')
      .single()
    if (claimErr || !claim) return 'duplicado'

    try {
      const wid = await enviarAvisoInterno(cfg.telefoneAviso, texto)
      await supabase.from('caso_avisos').update({ status: 'enviado', wid, enviado_em: new Date().toISOString() }).eq('id', claim.id)
      await supabase.from('caso_eventos').insert({ caso_id: caso.id, tipo: 'aviso_enviado', ator: 'sistema', detalhe: { tipo, chave } })
      return 'enviado'
    } catch (e) {
      await supabase.from('caso_avisos').update({ status: 'falhou', erro: String((e as Error)?.message ?? e).slice(0, 500) }).eq('id', claim.id)
      return 'falhou'
    }
  } catch (e) {
    console.error('[casos] aviso à equipe falhou:', e)
    return 'falhou'
  }
}

// ── Comandos #C pelo WhatsApp da equipe ─────────────────────────────────────

/** Número do Caso cujo aviso a mensagem cita (pelo id da mensagem citada). */
async function casoDoAvisoCitado(supabase: SupaAdmin, citadoWid: string | null | undefined): Promise<number | null> {
  const stanza = stanzaDe(citadoWid)
  if (!stanza) return null
  const { data } = await supabase
    .from('caso_avisos')
    .select('wid, caso:casos(numero)')
    .like('wid', `%${stanza}`)
    .order('criado_em', { ascending: false })
    .limit(5)
  const hit = (data ?? []).find((a: { wid: string | null }) => stanzaDe(a.wid) === stanza) as
    | { caso: { numero: number } | { numero: number }[] | null }
    | undefined
  const caso = Array.isArray(hit?.caso) ? hit?.caso[0] : hit?.caso
  return caso?.numero ?? null
}

/**
 * Mensagem do número de aviso: interpreta (código, citação do aviso ou Caso único
 * esperando) e executa. null = não é resposta de Caso — segue o fluxo normal.
 * Devolve o texto de confirmação para a equipe e, quando a ação pede, o id do
 * Caso cujo retorno deve rodar.
 */
export async function executarRespostaEquipe(
  supabase: SupaAdmin,
  texto: string,
  citadoWid?: string | null,
  /** Id desta mensagem: reentrega do webhook não executa (nem confirma) duas vezes. */
  wid?: string | null
): Promise<{ resposta: string; retornoCasoId: string | null } | null> {
  if (wid) {
    const { data: ja } = await supabase
      .from('caso_eventos').select('id').eq('tipo', 'comando_whatsapp').contains('detalhe', { wid }).limit(1)
    if (ja && ja.length > 0) return { resposta: '', retornoCasoId: null }
  }
  const [numeroCitado, { data: esperando }] = await Promise.all([
    casoDoAvisoCitado(supabase, citadoWid),
    supabase.from('casos').select('numero').eq('estado', 'aguardando_equipe').order('numero'),
  ])
  const cmd = interpretarRespostaEquipe(texto, {
    numeroCitado,
    esperando: (esperando ?? []).map((c: { numero: number }) => c.numero),
  })
  if (!cmd) return null
  return executarComando(supabase, cmd, wid ?? null)
}

/** Executa um comando já interpretado (ou devolve o erro de interpretação). */
async function executarComando(
  supabase: SupaAdmin,
  cmd: ComandoCaso | { erro: string },
  wid: string | null
): Promise<{ resposta: string; retornoCasoId: string | null }> {
  if ('erro' in cmd) return { resposta: cmd.erro, retornoCasoId: null }

  const { data: caso } = await supabase.from('casos').select('id').eq('numero', cmd.numero).maybeSingle()
  if (!caso) return { resposta: `Não encontrei o Caso #C${cmd.numero}.`, retornoCasoId: null }

  const r = await acaoEquipe(supabase, { casoId: caso.id, acao: cmd.acao, nota: cmd.nota, ator: 'whatsapp' })
  if (!r.ok) return { resposta: `#C${cmd.numero}: ${r.erro}`, retornoCasoId: null }

  await supabase.from('caso_eventos').insert({ caso_id: caso.id, tipo: 'comando_whatsapp', ator: 'whatsapp', detalhe: { acao: cmd.acao, ...(wid ? { wid } : {}) } })
  const feito = cmd.acao === 'concluir'
    ? 'concluído — a IA vai avisar a família.'
    : cmd.acao === 'pedir_info'
      ? 'a IA vai perguntar à família.'
      : 'passado para atendimento humano; a IA foi pausada nesse contato.'
  return { resposta: `✅ #C${cmd.numero} ${feito}`, retornoCasoId: r.retorno ? caso.id : null }
}
