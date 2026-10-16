/**
 * MAESTRO GUARDIÃO — modo conversacional ("reorganizar o sistema").
 *
 * Diferente de `politica.ts`/`validar-resposta.ts` (determinísticos, rodam a cada
 * mensagem de família), ESTE módulo é o Maestro que CONVERSA com o gestor: lê o
 * estado atual do sistema (snapshot), entende a instrução em linguagem natural e
 * devolve uma resposta + PROPOSTAS concretas de mudança.
 *
 * Contrato de segurança (igual ao espírito do guardião): o modelo SÓ PROPÕE.
 * Quem aplica é o gestor, clicando "Aplicar" — e é `aplicarAcao` (abaixo), com uma
 * ALLOWLIST FECHADA, que executa. O servidor NUNCA confia no que o modelo afirma
 * que a ação faz: revalida tipo e parâmetros aqui antes de tocar no banco.
 *
 * Mudanças que vivem em CÓDIGO (ex.: as diretrizes do Maestro em `diretrizes.ts`)
 * não são aplicáveis em runtime — viram recomendação (aplicavel:false) para o
 * gestor levar ao deploy.
 */
import { createServerAdminClient } from '@/lib/supabase-server'
import { chamarModeloIA, type Mensagem } from '@/lib/ia-credenciais'
import { resolverDiretrizes } from './diretrizes'
import { decidirPolitica } from './politica'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

// ──────────────────────────────────────────────────────────────────────────
// Allowlist de ações aplicáveis (DB-backed). Tudo fora disto é só conversa.
// ──────────────────────────────────────────────────────────────────────────

/** Flags booleanas do config_ia que o Maestro pode ligar/desligar. */
export const FLAGS_BOOL = ['salomao_ativo', 'followup_ativo', 'roteador_classificador_llm'] as const
/** Flags enumeradas do config_ia (chave → valores aceitos). */
export const FLAGS_ENUM: Record<string, readonly string[]> = {
  validacao_saida_modo: ['off', 'log', 'ativo'],
}

export type AcaoMaestro =
  | { tipo: 'config_flag'; chave: string; valor: boolean | string }
  | { tipo: 'agente_prompt'; agente: 'sara' | 'salomao'; prompt: string }
  | { tipo: 'agente_modelo'; agente: 'sara' | 'salomao'; modelo: string }
  | { tipo: 'maestro_diretrizes'; texto: string }
  | { tipo: 'lead_mover'; lead_id: string; coluna_id: string }
  | { tipo: 'lead_ia'; lead_id: string; ia_ativa: boolean }

/** Rascunho de mudança que vive em CÓDIGO: o Maestro redige, o gestor aprova e um
 *  desenvolvedor aplica + deploya. Não é executável em runtime. */
export interface RascunhoCodigo {
  /** Arquivo/área alvo, ex.: "src/lib/maestro/validar-resposta.ts (regex de veto)". */
  alvo: string
  /** O texto/diff exato proposto, para o dev colar. */
  conteudo: string
}

export interface Proposta {
  titulo: string
  descricao: string
  /** Null = não executável em runtime (mudança de código ou só recomendação). */
  acao: AcaoMaestro | null
  aplicavel: boolean
  /** Presente quando a mudança mora em código; mostrado para o dev aplicar. */
  rascunho_codigo?: RascunhoCodigo
}

export interface RespostaMaestro {
  resposta: string
  propostas: Proposta[]
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot do estado atual (sempre injetado — dispensa loop de leitura e mantém
// o Maestro honesto sobre o que existe de verdade no banco).
// ──────────────────────────────────────────────────────────────────────────

interface Snapshot {
  texto: string
  /** Chaves de config_ia que REALMENTE existem (evita propor coluna drift). */
  flagsPresentes: string[]
}

function truncar(s: string | null | undefined, n: number): string {
  if (!s) return '(vazio — usa o padrão do código)'
  return s.length > n ? s.slice(0, n) + '…' : s
}

const DIAS_PARADO = 7 // lead sem mudar de etapa há mais que isto conta como "parado"

async function montarSnapshot(db: SupaAdmin): Promise<Snapshot> {
  const [cfgResp, funisResp, colunasResp, leadsResp, amostraResp, auditResp, sugResp] = await Promise.all([
    db.from('config_ia').select('*').eq('id', 1).maybeSingle(),
    db.from('funis').select('id, nome, is_padrao').order('is_padrao', { ascending: false }),
    db.from('colunas').select('id, funil_id, nome, ordem').order('ordem'),
    db.from('leads').select('coluna_id, ia_ativa, entrou_coluna_em').eq('arquivado', false),
    db
      .from('leads')
      .select('id, coluna_id, ia_ativa, familia:familias(nome_responsavel), crianca:criancas(nome)')
      .eq('arquivado', false)
      .order('atualizado_em', { ascending: false })
      .limit(40),
    // Último ciclo de auditoria da Sara (resumo + nota + sugestões agregadas).
    db.from('auditorias_sara').select('nota_geral, resumo, sugestoes, conversas_analisadas, periodo_fim').order('periodo_fim', { ascending: false }).limit(1).maybeSingle(),
    // Gaps recorrentes ainda pendentes (por critério).
    db.from('sugestoes_auditoria').select('criterio, sugestao').eq('status', 'pendente').limit(200),
  ])

  const cfg = (cfgResp.data ?? {}) as Record<string, unknown>
  const flagsPresentes = Object.keys(cfg)

  const funis = (funisResp.data ?? []) as { id: string; nome: string; is_padrao: boolean }[]
  const colunas = (colunasResp.data ?? []) as { id: string; funil_id: string; nome: string; ordem: number }[]
  const leads = (leadsResp.data ?? []) as { coluna_id: string; ia_ativa: boolean; entrou_coluna_em: string | null }[]
  const amostra = (amostraResp.data ?? []) as unknown as {
    id: string
    coluna_id: string
    ia_ativa: boolean
    familia?: { nome_responsavel?: string } | null
    crianca?: { nome?: string } | null
  }[]

  const nomeColuna = new Map(colunas.map((c) => [c.id, c.nome]))
  const contagem = new Map<string, number>()
  const parados = new Map<string, number>()
  let pausados = 0
  const agora = Date.now()
  for (const l of leads) {
    contagem.set(l.coluna_id, (contagem.get(l.coluna_id) ?? 0) + 1)
    if (!l.ia_ativa) pausados++
    if (l.entrou_coluna_em) {
      const dias = (agora - new Date(l.entrou_coluna_em).getTime()) / 86400000
      if (dias > DIAS_PARADO) parados.set(l.coluna_id, (parados.get(l.coluna_id) ?? 0) + 1)
    }
  }

  // Diagnóstico do roteador com o estado atual (sem opt-out/force/pausa por lead).
  const diag = decidirPolitica({
    optOut: false,
    precisaAtendimentoHumano: false,
    iaAtiva: true,
    jaResponsavel: false,
    salomaoAtivo: !!cfg.salomao_ativo,
  })

  const bloFlags = [
    `salomao_ativo = ${String(cfg.salomao_ativo ?? '(ausente)')}`,
    `followup_ativo = ${String(cfg.followup_ativo ?? '(ausente)')}`,
    'validacao_saida_modo' in cfg ? `validacao_saida_modo = ${String(cfg.validacao_saida_modo)}` : 'validacao_saida_modo = (coluna ausente no banco — não aplicável até criar)',
    'roteador_classificador_llm' in cfg ? `roteador_classificador_llm = ${String(cfg.roteador_classificador_llm)}` : 'roteador_classificador_llm = (coluna ausente no banco — não aplicável até criar)',
    `modelo (Sara) = ${String(cfg.modelo ?? '(ausente)')}`,
    `salomao_modelo = ${String(cfg.salomao_modelo ?? '(usa o da Sara)')}`,
  ].join('\n')

  const bloFunis = funis
    .map((f) => {
      const cols = colunas
        .filter((c) => c.funil_id === f.id)
        .map((c) => {
          const p = parados.get(c.id) ?? 0
          return `    - [${c.id}] ${c.nome} (${contagem.get(c.id) ?? 0} leads${p ? `, ${p} parados >${DIAS_PARADO}d` : ''})`
        })
        .join('\n')
      return `  • ${f.nome}${f.is_padrao ? ' (padrão)' : ''} [${f.id}]\n${cols || '    (sem etapas)'}`
    })
    .join('\n')

  const bloAmostra = amostra
    .map((l) => `  - [${l.id}] ${l.familia?.nome_responsavel ?? '(sem nome)'} / ${l.crianca?.nome ?? '—'} · etapa: ${nomeColuna.get(l.coluna_id) ?? '?'} · IA: ${l.ia_ativa ? 'ativa' : 'pausada'}`)
    .join('\n')

  // ── Sinais de qualidade (aprender com as conversas) ──
  const audit = auditResp.data as { nota_geral: number | null; resumo: string | null; sugestoes: unknown; conversas_analisadas: number | null; periodo_fim: string | null } | null
  const sugs = (sugResp.data ?? []) as { criterio: string | null; sugestao: string | null }[]
  const porCriterio = new Map<string, { n: number; exemplo: string }>()
  for (const s of sugs) {
    const c = s.criterio || 'outros'
    const atual = porCriterio.get(c) ?? { n: 0, exemplo: s.sugestao || '' }
    porCriterio.set(c, { n: atual.n + 1, exemplo: atual.exemplo || s.sugestao || '' })
  }
  const topGaps = [...porCriterio.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 4)
    .map(([c, v]) => `  - ${c}: ${v.n} conversa(s). Ex.: ${truncar(v.exemplo, 160)}`)
    .join('\n')

  const sugestoesAudit = Array.isArray(audit?.sugestoes)
    ? (audit!.sugestoes as unknown[]).slice(0, 5).map((x) => `  - ${typeof x === 'string' ? x : JSON.stringify(x).slice(0, 160)}`).join('\n')
    : ''

  const bloQualidade = `Última auditoria da Sara: ${audit ? `nota ${audit.nota_geral ?? '—'}/100, ${audit.conversas_analisadas ?? 0} conversas (até ${audit.periodo_fim?.slice(0, 10) ?? '?'}).` : 'nenhuma ainda.'}
${audit?.resumo ? `Resumo: ${truncar(audit.resumo, 400)}` : ''}
${sugestoesAudit ? `Sugestões da auditoria:\n${sugestoesAudit}` : ''}
Gaps recorrentes pendentes (por critério, da fila de sugestões):
${topGaps || '  (nenhum gap pendente)'}`

  // ── Coerência de config (checagens determinísticas p/ o Maestro apontar) ──
  const alertas: string[] = []
  if (cfg.salomao_ativo && !((cfg.salomao_system_prompt as string) || '').trim())
    alertas.push('Salomão está ATIVO mas sem preâmbulo de persona (salomao_system_prompt vazio) — usa o padrão do código.')
  if (cfg.followup_ativo === false) alertas.push('Follow-up automático DESLIGADO (followup_ativo=false): nenhum lembrete proativo sai.')
  if (!((cfg.system_prompt as string) || '').trim()) alertas.push('Sara sem system_prompt no banco — usa o fallback mínimo do código.')
  if (pausados > 0) alertas.push(`${pausados} lead(s) ativos com IA pausada (não recebem resposta automática).`)

  const diretrizesEfetivas = resolverDiretrizes(cfg as { maestro_diretrizes?: string | null })
  const overrideAtivo = typeof cfg.maestro_diretrizes === 'string' && (cfg.maestro_diretrizes as string).trim().length > 0

  const texto = `ESTADO ATUAL DO SISTEMA (snapshot — dados reais do banco vivo)

── Config da IA (config_ia #1) ──
${bloFlags}

Prompt da Sara (início): ${truncar(cfg.system_prompt as string, 240)}
Prompt do Salomão (início): ${truncar(cfg.salomao_system_prompt as string, 240)}

── Diagnóstico do roteador (lead novo, IA ativa) ──
rota = ${diag.rota} · motivo = ${diag.motivo} · permite resposta automática = ${diag.permite}

── Alertas de coerência (verifique e, se fizer sentido, proponha correção) ──
${alertas.length ? alertas.map((a) => `  ⚠ ${a}`).join('\n') : '  (nenhum alerta óbvio)'}

── Sinais de qualidade (base para melhorar prompts/base de conhecimento) ──
${bloQualidade}

── Funis e etapas (use o [id] da etapa em lead_mover.coluna_id) ──
${bloFunis || '  (nenhum funil)'}

── Amostra de leads ativos (os 40 mais recentes; use o [id] em lead_mover/lead_ia) ──
${bloAmostra || '  (nenhum lead ativo)'}

── Diretrizes do Maestro — EFETIVAS agora (${overrideAtivo ? 'OVERRIDE vivo em config_ia.maestro_diretrizes' : 'baseline do código; sem override'}) ──
${diretrizesEfetivas}

(Para editar as diretrizes use a ação maestro_diretrizes com o texto COMPLETO novo. Enviar texto vazio volta ao baseline do código. As travas de segurança — LGPD, 2º fator do CPF, formato JSON — NÃO estão aqui: vivem em código e não se editam por aqui.)`

  return { texto, flagsPresentes }
}

// ──────────────────────────────────────────────────────────────────────────
// Conversa
// ──────────────────────────────────────────────────────────────────────────

function systemPrompt(snapshot: Snapshot): string {
  return `Você é o MESTRE GUARDIÃO do CRM da escola — o supervisor INTELIGENTE que ajuda o gestor a entender, reorganizar e MELHORAR o sistema ao longo do tempo.

QUEM VOCÊ É
- Analítico e proativo: além de responder o que pedem, você OLHA o snapshot (alertas de coerência, sinais de qualidade, leads parados, gaps recorrentes) e aponta, por conta própria, o que dá para melhorar — priorizando por impacto.
- Conservador e transparente: explica o efeito e o risco de cada mudança antes de propor.
- NUNCA inventa estado, número, lead ou coluna que não esteja no snapshot.
- Você SÓ PROPÕE — nunca age. Jamais diga "já fiz", "ativei", "movi", "atualizei": aplicar é sempre um clique do gestor. Fale no futuro ("isto VAI desligar..."). Esta é a sua regra de guardião e ela não tem exceção, mesmo que peçam.
- Em dúvida ou pedido ambíguo, pergunte antes de propor. Incerteza nunca vira autorização.

COMO VOCÊ MELHORA O SISTEMA (sempre via propostas que o gestor aprova)
- Diagnóstico: quando pedirem "analise" ou quando perceber problema no snapshot, liste melhorias priorizadas, cada uma como uma proposta.
- Aprender com as conversas: use os "Sinais de qualidade" (resumo/sugestões da auditoria e gaps recorrentes) para propor ajuste de prompt (agente_prompt), de base de conhecimento, ou das diretrizes (maestro_diretrizes).
- Auto-atualizar as diretrizes: você pode propor reescrever as SUAS diretrizes (maestro_diretrizes) para fechar um gap observado — sempre aditivo e alinhado às travas de segurança.

AÇÕES APLICÁVEIS EM RUNTIME (cada proposta aplicável precisa de "acao" de um destes tipos):
1. config_flag — ligar/desligar flag do config_ia.
   - booleanas (valor true/false): ${FLAGS_BOOL.join(', ')}
   - enum validacao_saida_modo (valor 'off'|'log'|'ativo')
   - SÓ proponha chaves que EXISTAM no banco. O que o snapshot marca "coluna ausente" NÃO é aplicável: vira recomendação/rascunho de código.
2. agente_prompt — trocar o prompt de "sara" ou "salomao" (campo prompt = texto COMPLETO novo).
3. agente_modelo — trocar o modelo de "sara" ou "salomao" (campo modelo, ex.: "gpt-4o").
4. maestro_diretrizes — reescrever as diretrizes do Maestro (campo texto = texto COMPLETO novo; vazio volta ao baseline do código).
5. lead_mover — mover um lead para outra etapa: { lead_id, coluna_id } com os [id] do snapshot.
6. lead_ia — ligar/desligar a IA de um lead: { lead_id, ia_ativa }.

MUDANÇAS QUE VIVEM EM CÓDIGO (não aplicáveis em runtime): travas de segurança (LGPD, 2º fator do CPF, formato JSON), lógica do roteador/validador, colunas de banco que ainda não existem. Para elas: "acao": null, "aplicavel": false, e preencha "rascunho_codigo" com { "alvo": "arquivo/área", "conteudo": "o texto/trecho exato a aplicar" }. O gestor aprova e um desenvolvedor aplica + deploya. NUNCA finja que mudança de código entra sozinha.

FORMATO DA RESPOSTA — responda SOMENTE com um objeto JSON válido, sem markdown fora dele:
{
  "resposta": "sua fala para o gestor (markdown simples: listas, **negrito**)",
  "propostas": [
    {
      "titulo": "curto",
      "descricao": "o que muda, por quê (cite o sinal do snapshot que motivou), e o risco",
      "acao": { "tipo": "config_flag", "chave": "salomao_ativo", "valor": false },
      "aplicavel": true
    },
    {
      "titulo": "exemplo de mudança de código",
      "descricao": "por que, e que exige deploy",
      "acao": null,
      "aplicavel": false,
      "rascunho_codigo": { "alvo": "src/lib/maestro/validar-resposta.ts", "conteudo": "..." }
    }
  ]
}
Se não houver nada a mudar (só conversa/diagnóstico), use "propostas": [].

${snapshot.texto}`
}

interface ParsedProposta {
  titulo?: unknown
  descricao?: unknown
  acao?: unknown
  aplicavel?: unknown
  rascunho_codigo?: unknown
}

function normalizarRascunho(raw: unknown): RascunhoCodigo | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const alvo = typeof r.alvo === 'string' ? r.alvo.trim() : ''
  const conteudo = typeof r.conteudo === 'string' ? r.conteudo.trim() : ''
  if (!alvo && !conteudo) return undefined
  return { alvo: alvo || '(não especificado)', conteudo }
}

function sanearProposta(p: ParsedProposta): Proposta | null {
  const titulo = typeof p.titulo === 'string' ? p.titulo.trim() : ''
  const descricao = typeof p.descricao === 'string' ? p.descricao.trim() : ''
  if (!titulo && !descricao) return null
  const acao = normalizarAcao(p.acao)
  const rascunho = normalizarRascunho(p.rascunho_codigo)
  return {
    titulo: titulo || 'Proposta',
    descricao,
    acao,
    // Só é aplicável se tem ação válida E o modelo não marcou como recomendação.
    aplicavel: acao !== null && p.aplicavel !== false,
    ...(rascunho ? { rascunho_codigo: rascunho } : {}),
  }
}

/** Confere o formato bruto da ação vindo do modelo; descarta o que não bater. */
function normalizarAcao(raw: unknown): AcaoMaestro | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  switch (a.tipo) {
    case 'config_flag':
      if (typeof a.chave !== 'string') return null
      if ((FLAGS_BOOL as readonly string[]).includes(a.chave) && typeof a.valor === 'boolean')
        return { tipo: 'config_flag', chave: a.chave, valor: a.valor }
      if (a.chave in FLAGS_ENUM && typeof a.valor === 'string' && FLAGS_ENUM[a.chave].includes(a.valor))
        return { tipo: 'config_flag', chave: a.chave, valor: a.valor }
      return null
    case 'agente_prompt':
      if ((a.agente === 'sara' || a.agente === 'salomao') && typeof a.prompt === 'string')
        return { tipo: 'agente_prompt', agente: a.agente, prompt: a.prompt }
      return null
    case 'agente_modelo':
      if ((a.agente === 'sara' || a.agente === 'salomao') && typeof a.modelo === 'string')
        return { tipo: 'agente_modelo', agente: a.agente, modelo: a.modelo }
      return null
    case 'maestro_diretrizes':
      if (typeof a.texto === 'string') return { tipo: 'maestro_diretrizes', texto: a.texto }
      return null
    case 'lead_mover':
      if (typeof a.lead_id === 'string' && typeof a.coluna_id === 'string')
        return { tipo: 'lead_mover', lead_id: a.lead_id, coluna_id: a.coluna_id }
      return null
    case 'lead_ia':
      if (typeof a.lead_id === 'string' && typeof a.ia_ativa === 'boolean')
        return { tipo: 'lead_ia', lead_id: a.lead_id, ia_ativa: a.ia_ativa }
      return null
    default:
      return null
  }
}

export async function conversarComMaestro(historico: Mensagem[], db?: SupaAdmin): Promise<RespostaMaestro> {
  const supa = db ?? createServerAdminClient()
  const snapshot = await montarSnapshot(supa)

  const cfg = await supa.from('config_ia').select('modelo').eq('id', 1).maybeSingle()
  const model = (cfg.data?.modelo as string) || 'gpt-4o'

  const messages: Mensagem[] = [
    { role: 'system', content: systemPrompt(snapshot) },
    ...historico.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-16),
  ]

  const bruto = await chamarModeloIA('maestro', { messages, model, maxTokens: 2600, jsonMode: true }, supa)

  let parsed: { resposta?: unknown; propostas?: unknown }
  try {
    parsed = JSON.parse(bruto)
  } catch {
    // Modelo não devolveu JSON — trata tudo como fala, sem propostas.
    return { resposta: bruto.trim() || 'Não consegui formular uma resposta agora. Tente reformular.', propostas: [] }
  }

  const resposta = typeof parsed.resposta === 'string' ? parsed.resposta.trim() : 'Pronto.'
  const propostasBrutas = Array.isArray(parsed.propostas) ? parsed.propostas : []
  const propostas = propostasBrutas
    .map((p) => sanearProposta(p as ParsedProposta))
    .filter((p): p is Proposta => p !== null)

  return { resposta, propostas }
}

// ──────────────────────────────────────────────────────────────────────────
// Aplicação (gatilho do gestor). Revalida TUDO antes de escrever.
// ──────────────────────────────────────────────────────────────────────────

export interface ResultadoAplicacao {
  ok: boolean
  mensagem: string
}

export async function aplicarAcao(raw: unknown, db?: SupaAdmin): Promise<ResultadoAplicacao> {
  const acao = normalizarAcao(raw)
  if (!acao) return { ok: false, mensagem: 'Ação inválida ou fora da lista permitida.' }
  const supa = db ?? createServerAdminClient()
  const agora = new Date().toISOString()

  try {
    switch (acao.tipo) {
      case 'config_flag': {
        const { error } = await supa.from('config_ia').update({ [acao.chave]: acao.valor, atualizado_em: agora }).eq('id', 1)
        if (error) return { ok: false, mensagem: `Falha no banco: ${error.message}` }
        return { ok: true, mensagem: `${acao.chave} = ${String(acao.valor)} aplicado.` }
      }
      case 'agente_prompt': {
        const col = acao.agente === 'sara' ? 'system_prompt' : 'salomao_system_prompt'
        const valor = acao.prompt.trim() || null
        const { error } = await supa.from('config_ia').update({ [col]: valor, atualizado_em: agora }).eq('id', 1)
        if (error) return { ok: false, mensagem: `Falha no banco: ${error.message}` }
        return { ok: true, mensagem: `Prompt do ${acao.agente} atualizado.` }
      }
      case 'agente_modelo': {
        const col = acao.agente === 'sara' ? 'modelo' : 'salomao_modelo'
        const valor = acao.modelo.trim() || null
        const { error } = await supa.from('config_ia').update({ [col]: valor, atualizado_em: agora }).eq('id', 1)
        if (error) return { ok: false, mensagem: `Falha no banco: ${error.message}` }
        return { ok: true, mensagem: `Modelo do ${acao.agente} = ${valor ?? '(padrão)'} aplicado.` }
      }
      case 'maestro_diretrizes': {
        const valor = acao.texto.trim() || null
        const { error } = await supa.from('config_ia').update({ maestro_diretrizes: valor, atualizado_em: agora }).eq('id', 1)
        if (error) return { ok: false, mensagem: `Falha no banco: ${error.message}` }
        return { ok: true, mensagem: valor ? 'Diretrizes do Maestro atualizadas (override vivo).' : 'Diretrizes voltaram ao baseline do código.' }
      }
      case 'lead_mover': {
        // Valida que a etapa de destino existe de fato.
        const { data: col } = await supa.from('colunas').select('id, nome').eq('id', acao.coluna_id).maybeSingle()
        if (!col) return { ok: false, mensagem: 'Etapa de destino não existe.' }
        const { error } = await supa
          .from('leads')
          .update({ coluna_id: acao.coluna_id, entrou_coluna_em: agora, atualizado_em: agora })
          .eq('id', acao.lead_id)
        if (error) return { ok: false, mensagem: `Falha no banco: ${error.message}` }
        return { ok: true, mensagem: `Lead movido para "${(col as { nome: string }).nome}".` }
      }
      case 'lead_ia': {
        const { error } = await supa.from('leads').update({ ia_ativa: acao.ia_ativa, atualizado_em: agora }).eq('id', acao.lead_id)
        if (error) return { ok: false, mensagem: `Falha no banco: ${error.message}` }
        return { ok: true, mensagem: `IA do lead ${acao.ia_ativa ? 'reativada' : 'pausada'}.` }
      }
    }
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message.slice(0, 200) : 'Erro ao aplicar.' }
  }
}
