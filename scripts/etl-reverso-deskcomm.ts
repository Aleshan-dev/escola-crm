/**
 * ETL REVERSO — Deskcomm (vdtlfz, public) → legado escola-crm (zdarzt, schema crm).
 *
 * Traz de volta o DELTA acumulado no Deskcomm desde o cutover (~28/09): contatos,
 * alunos, leads e mensagens que NÃO vieram do legado. Idempotente:
 *   - contatos: dedupe por telefone (constraint familias_telefone_key);
 *   - alunos: dedupe por (familia, nome);
 *   - leads: 1 por família (pula se a família já tem lead);
 *   - mensagens: dedupe por whatsapp_message_id (external_id) já presente no crm.
 * CPF do delta fica NULO (leads de captação quase nunca têm; conta os cpf_presente).
 *
 * Uso (a partir da pasta do legado, com o tsx do fork):
 *   tsx scripts/etl-reverso-deskcomm.ts            # DRY-RUN (não escreve)
 *   tsx scripts/etl-reverso-deskcomm.ts --apply    # aplica no crm
 *
 * Não imprime segredos. Lê os .env.local dos dois projetos por caminho absoluto.
 */
import { readFileSync } from 'node:fs'
import * as readline from 'node:readline'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const LEGACY_ENV = 'D:/Claude/Projects/CRM Escola/.env.local'
const FORK_ENV = 'D:/Claude/Projects/CRM ESCOLA 2 (main)/.env.local'
const APPLY = process.argv.includes('--apply')

function envFrom(path: string, key: string): string {
  const txt = readFileSync(path, 'utf8')
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() === key) {
      let v = line.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return v
    }
  }
  throw new Error(`env ${key} não encontrada em ${path}`)
}

const src = createClient(
  envFrom(FORK_ENV, 'NEXT_PUBLIC_SUPABASE_URL'),
  envFrom(FORK_ENV, 'SUPABASE_SERVICE_ROLE_KEY'),
  { db: { schema: 'public' }, auth: { autoRefreshToken: false, persistSession: false } }
)
// Chave de ESCRITA do legado (zdarzt): pede na hora (stdin) se não vier por env.
// Assim não precisa de variável de ambiente, aspas, nem arquivo em disco.
const DST_URL = process.env.DST_SUPABASE_URL || envFrom(LEGACY_ENV, 'NEXT_PUBLIC_SUPABASE_URL')
let dst: SupabaseClient // inicializado em main(), após obter a chave

function obterChaveDst(): Promise<string> {
  const envKey = process.env.SUPABASE_SECRET_KEY
  if (envKey && !envKey.startsWith('[')) return Promise.resolve(envKey.trim())
  // Arquivo de chave (mais fácil que colar no prompt): um .txt com só a chave dentro.
  for (const p of ['C:/Users/Aleshan/sgei-key.txt', './sgei-key.txt']) {
    try {
      const k = readFileSync(p, 'utf8').trim()
      if (k && !k.startsWith('[')) { console.log(`(chave lida de ${p})`); return Promise.resolve(k) }
    } catch { /* arquivo ausente, tenta o próximo */ }
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((res) =>
    rl.question(
      'Cole a chave de ESCRITA do projeto sgei (service_role eyJ... ou sb_secret_...) e tecle Enter:\n> ',
      (ans) => { rl.close(); res(ans.trim()) }
    )
  )
}

// Telefones a NÃO importar (número da própria escola e o de teste do WAHA).
const JUNK_PHONES = new Set(['+68981050916', '+5568996015656'])

// Coluna de fallback para lead sem match de etapa (crm.leads.coluna_id é NOT NULL).
// "Capturados" = 1ª coluna do funil padrão (captação) do crm@zdarzt.
const FALLBACK_COLUNA = '18f1f407-cbe1-4493-8e38-50fc71e920fa'

// Mapeia o `type` das atividades do Deskcomm para o enum `eventos_timeline.tipo` do
// legado. O que NÃO está aqui é telemetria do motor (lead_cooled, reactivation_*,
// ai_turn, send_vetoed, handoff_*, demand_*, next_action_*…) — sem sentido no legado,
// é PULADO em vez de inserido com rótulo errado.
const EVENTO_TIPO_MAP: Record<string, string> = {
  lead_created: 'criado', criado: 'criado',
  stage_changed: 'movido_coluna', movido_coluna: 'movido_coluna',
  anotacao: 'anotacao', status_ia: 'status_ia', lead_edited: 'status_ia',
  appointment_scheduled: 'visita_agendada', visita_agendada: 'visita_agendada',
  followup_scheduled: 'visita_agendada', appointment_completed: 'visita_realizada',
}
// status do Deskcomm -> enum tarefas.status do legado.
const VISITA_STATUS_MAP: Record<string, string> = {
  confirmed: 'agendada', completed: 'realizada', no_show: 'ausente', cancelled: 'cancelada',
}

type Row = Record<string, any>

async function fetchAll(client: SupabaseClient, table: string, cols: string): Promise<Row[]> {
  const out: Row[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select(cols).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return out
}

const legacyId = (sm: Row | null, cf: Row | null): string | null =>
  (sm?.legacy_id ?? cf?.legacy_id ?? null) as string | null

const TIPO_MIDIA: Record<string, string> = {
  text: 'texto', image: 'imagem', audio: 'audio', voice: 'audio',
  document: 'documento', file: 'documento', video: 'video', sticker: 'imagem',
}

async function main() {
  const DST_KEY = await obterChaveDst()
  if (!DST_KEY || DST_KEY.startsWith('[')) { console.error('Chave inválida — abortando.'); process.exit(1) }
  dst = createClient(DST_URL, DST_KEY, { db: { schema: 'crm' }, auth: { autoRefreshToken: false, persistSession: false } })
  console.log(`\n=== ETL REVERSO Deskcomm→crm | modo: ${APPLY ? 'APPLY (escreve)' : 'DRY-RUN'} ===\n`)

  // ---- Carrega os dois lados (leitura) ----
  const [contacts, students, leads, convs] = await Promise.all([
    fetchAll(src, 'contacts', 'id,name,display_name,email,phone_number,source,source_metadata,custom_fields,created_at,updated_at'),
    fetchAll(src, 'crm_students', 'id,contact_id,name,birthdate,grade_desired,shift,notes,custom_fields'),
    fetchAll(src, 'crm_leads', 'id,contact_id,student_id,stage_id,status,source,source_metadata,custom_fields,created_at,updated_at,last_activity_at,closed_at,lost_reason'),
    fetchAll(src, 'conversations', 'id,contact_id'),
  ])
  const srcStages = await fetchAll(src, 'crm_stages', 'id,name,pipeline_id')
  const srcPipes = await fetchAll(src, 'crm_pipelines', 'id,name')

  const dstFamilias = await fetchAll(dst, 'familias', 'id,telefone,telefone_norm')
  const dstCriancas = await fetchAll(dst, 'criancas', 'id,familia_id,nome')
  const dstLeads = await fetchAll(dst, 'leads', 'id,familia_id,criado_em')
  const dstColunas = await fetchAll(dst, 'colunas', 'id,nome,funil_id')
  const dstFunis = await fetchAll(dst, 'funis', 'id,nome')
  const dstMsgIds = await fetchAll(dst, 'mensagens', 'whatsapp_message_id')

  // ---- Índices ----
  // Dedupe por telefone NORMALIZADO (últimos 8 dígitos) — pega +5568... vs +68...
  // (mesma família em formatos diferentes, o clássico 9º dígito/sem país).
  const normFone = (p: string | null | undefined) => (p ? String(p).replace(/\D/g, '').slice(-8) : '')
  const famByPhone = new Map<string, string>()
  for (const f of dstFamilias) {
    for (const t of [f.telefone, f.telefone_norm]) { const k = normFone(t); if (k) famByPhone.set(k, f.id) }
  }
  const pipeName = new Map(srcPipes.map((p) => [p.id, p.name]))
  const funilName = new Map(dstFunis.map((f) => [f.nome, f.id]))
  const colunaByFunilNome = new Map<string, string>() // `${funil_id}|${nome.toLowerCase()}` -> coluna id
  for (const c of dstColunas) colunaByFunilNome.set(`${c.funil_id}|${String(c.nome).toLowerCase()}`, c.id)
  // stage_id (src) -> coluna_id (dst) por (nome do pipeline + nome da etapa)
  const stageToColuna = new Map<string, string>()
  for (const s of srcStages) {
    const pNome = pipeName.get(s.pipeline_id)
    const funilId = pNome ? funilName.get(pNome) : undefined
    if (!funilId) continue
    const col = colunaByFunilNome.get(`${funilId}|${String(s.name).toLowerCase()}`)
    if (col) stageToColuna.set(s.id, col)
  }
  const dstMsgSet = new Set(dstMsgIds.map((m) => m.whatsapp_message_id).filter(Boolean))

  // familia -> lead (dst): último lead por família
  const famToLead = new Map<string, string>()
  for (const l of [...dstLeads].sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)))) {
    if (l.familia_id) famToLead.set(l.familia_id, l.id)
  }

  const stats: Record<string, number> = {
    familias_novas: 0, familias_existentes: 0, familias_sem_telefone: 0, familias_junk_excluido: 0, familias_erro: 0, cpf_presente_ignorado: 0,
    criancas_novas: 0, criancas_dup: 0, criancas_erro: 0,
    leads_novos: 0, leads_pulados_familia_ja_tem: 0, leads_sem_coluna_fallback: 0, leads_erro: 0,
    msgs_novas: 0, msgs_ja_existem: 0, msgs_sem_extid: 0, msgs_sem_lead: 0, msgs_erro: 0,
    anotacoes_novas: 0, anotacoes_ja_existem: 0, anotacoes_sem_lead: 0, anotacoes_erro: 0,
    eventos_novos: 0, eventos_ja_existem: 0, eventos_sem_lead: 0, eventos_ignorados_telemetria: 0, eventos_erro: 0,
    visitas_novas: 0, visitas_ja_existem: 0, visitas_sem_lead: 0, visitas_erro: 0,
  }

  const contactToFamilia = new Map<string, string>() // src contact id -> dst familia id

  // ---- 1) CONTATOS -> familias ----
  for (const c of contacts) {
    const sm = c.source_metadata ?? {}
    const cf = c.custom_fields ?? {}
    const lid = legacyId(sm, cf)
    if (lid) { contactToFamilia.set(c.id, lid); stats.familias_existentes++; continue }
    const fone = c.phone_number ? String(c.phone_number) : null
    if (!fone) { stats.familias_sem_telefone++; continue }
    if (JUNK_PHONES.has(fone)) { stats.familias_junk_excluido++; continue }
    const existente = famByPhone.get(normFone(fone))
    if (existente) { contactToFamilia.set(c.id, existente); stats.familias_existentes++; continue }
    if (cf.cpf_presente === true) stats.cpf_presente_ignorado++
    const novaFamilia: Row = {
      nome_responsavel: c.name || c.display_name || 'Família',
      telefone: fone, telefone_norm: fone, email: c.email ?? null,
      origem: sm.origem ?? c.source ?? 'whatsapp',
      canal: sm.canal ?? 'organico', campanha: sm.campanha ?? null, referral: sm.referral ?? null,
      cpf: null, rg: cf.rg ?? null, tipo_responsavel: cf.tipo_responsavel ?? null,
      cep: cf.cep ?? null, rua: cf.rua ?? null, numero: cf.numero ?? null, complemento: cf.complemento ?? null,
      bairro: cf.bairro ?? null, cidade: cf.cidade ?? null, estado: cf.estado ?? null, pais: cf.pais ?? null,
      whatsapp_phone_number_id: cf.whatsapp_phone_number_id ?? null,
      ja_responsavel: cf.ja_responsavel === true, sgei_nome: cf.sgei_nome ?? null,
      sgei_vinculo_ativo: typeof cf.sgei_vinculo_ativo === 'boolean' ? cf.sgei_vinculo_ativo : null,
      sgei_checado_em: cf.sgei_checado_em ?? null, canal_whatsapp: cf.canal_whatsapp ?? null,
      criado_em: c.created_at ?? null, atualizado_em: c.updated_at ?? null,
    }
    if (APPLY) {
      const { data, error } = await dst.from('familias').insert(novaFamilia).select('id').single()
      if (error || !data) { console.error(`familias insert falhou (${fone}): ${error?.message}`); stats.familias_erro++; continue }
      contactToFamilia.set(c.id, data.id); famByPhone.set(normFone(fone), data.id); stats.familias_novas++
    } else {
      contactToFamilia.set(c.id, `DRY:${c.id}`); stats.familias_novas++
    }
  }

  // ---- 2) ALUNOS -> criancas ----
  const studentToCrianca = new Map<string, string>()
  const criancaKey = new Set(dstCriancas.map((x) => `${x.familia_id}|${String(x.nome).toLowerCase()}`))
  for (const s of students) {
    const fam = contactToFamilia.get(s.contact_id)
    if (!fam) continue
    const nome = s.name || 'A confirmar'
    const key = `${fam}|${String(nome).toLowerCase()}`
    if (!String(fam).startsWith('DRY:') && criancaKey.has(key)) { stats.criancas_dup++; continue }
    const cf = s.custom_fields ?? {}
    const nova: Row = {
      familia_id: fam, nome, data_nascimento: s.birthdate ?? null,
      serie_desejada: s.grade_desired ?? null, periodo: s.shift ?? null, motivo_busca: s.notes ?? null,
      idade: cf.idade ?? null, idade_meses: cf.idade_meses ?? null, aluno_id: cf.aluno_id ?? null,
    }
    if (APPLY) {
      const { data, error } = await dst.from('criancas').insert(nova).select('id').single()
      if (error || !data) { console.error(`criancas insert falhou: ${error?.message}`); stats.criancas_erro++; continue }
      studentToCrianca.set(s.id, data.id); criancaKey.add(key); stats.criancas_novas++
    } else {
      studentToCrianca.set(s.id, `DRY:${s.id}`); stats.criancas_novas++
    }
  }

  // ---- 3) LEADS -> leads ----
  for (const l of leads) {
    const sm = l.source_metadata ?? {}
    const cf = l.custom_fields ?? {}
    if (legacyId(sm, cf)) continue // já existe no legado
    const fam = contactToFamilia.get(l.contact_id)
    if (!fam) continue
    if (!String(fam).startsWith('DRY:') && famToLead.has(fam)) { stats.leads_pulados_familia_ja_tem++; continue }
    const colunaMatch = l.stage_id ? stageToColuna.get(l.stage_id) ?? null : null
    if (!colunaMatch) stats.leads_sem_coluna_fallback++
    const coluna = colunaMatch ?? FALLBACK_COLUNA
    const cog = cf.cog ?? {}
    const novo: Row = {
      familia_id: fam,
      crianca_id: l.student_id ? (studentToCrianca.get(l.student_id) ?? null) : null,
      coluna_id: coluna,
      score: cf.score ?? null, temperatura: cf.temperatura ?? null,
      ia_ativa: cf.ia_ativa === true,
      arquivado: cf.arquivado === true || l.status === 'lost',
      motivo_perda: l.lost_reason ?? cf.motivo_perda_original ?? null,
      motivo_busca: cf.motivo_busca ?? null, escola_atual: cf.escola_atual ?? null,
      primeira_experiencia: cf.primeira_experiencia ?? null, quando_iniciar: cf.quando_iniciar ?? null,
      sugestao_matricula: cf.sugestao_matricula === true,
      cog_intencao: cog.intencao ?? null, cog_emocao: cog.emocao ?? null, cog_temperatura: cog.temperatura ?? null,
      cog_interesse: cog.interesse ?? null, cog_urgencia: cog.urgencia ?? null, cog_probabilidade: cog.probabilidade ?? null,
      cog_proxima_acao: cog.proxima_acao ?? null,
      convertido_em: l.status === 'won' ? (l.closed_at ?? null) : null,
      criado_em: l.created_at ?? null, atualizado_em: l.updated_at ?? null,
      ultima_interacao_em: l.last_activity_at ?? null,
    }
    if (APPLY) {
      const { data, error } = await dst.from('leads').insert(novo).select('id').single()
      if (error || !data) { console.error(`leads insert falhou: ${error?.message}`); stats.leads_erro++; continue }
      famToLead.set(fam, data.id); stats.leads_novos++
    } else {
      stats.leads_novos++
    }
  }
  // Recarrega familia->lead após inserts (para rotear mensagens de leads novos)
  const dstLeads2 = APPLY ? await fetchAll(dst, 'leads', 'id,familia_id,criado_em') : dstLeads
  const famToLead2 = new Map<string, string>()
  for (const l of [...dstLeads2].sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)))) {
    if (l.familia_id) famToLead2.set(l.familia_id, l.id)
  }

  // ---- 4) MENSAGENS -> mensagens ----
  const convToLead = new Map<string, string>()
  for (const cv of convs) {
    const fam = contactToFamilia.get(cv.contact_id)
    if (!fam || String(fam).startsWith('DRY:')) continue
    const lead = famToLead2.get(fam)
    if (lead) convToLead.set(cv.id, lead)
  }
  const srcMsgs = await fetchAll(src, 'messages', 'id,conversation_id,external_id,type,direction,status,body,media_url,sent_at,created_at,read_at,metadata')
  const paraInserir: Row[] = []
  for (const m of srcMsgs) {
    if (!m.external_id) { stats.msgs_sem_extid++; continue }
    if (dstMsgSet.has(m.external_id)) { stats.msgs_ja_existem++; continue }
    const lead = convToLead.get(m.conversation_id)
    if (!lead) { stats.msgs_sem_lead++; continue }
    const meta = m.metadata ?? {}
    const direcao = m.direction === 'inbound' ? 'in' : (meta.agente === 'humano' ? 'out_humano' : 'out_ia')
    paraInserir.push({
      lead_id: lead, direcao, conteudo: m.body ?? '',
      tipo_midia: TIPO_MIDIA[String(m.type)] ?? 'texto', url_midia: m.media_url ?? null,
      whatsapp_message_id: m.external_id, criado_em: m.sent_at ?? m.created_at ?? null,
      status: m.status ?? null, lida: m.read_at ? true : false,
      agente: meta.agente ?? null, agente_origem: meta.agente_origem ?? null,
    })
    stats.msgs_novas++
  }
  if (APPLY && paraInserir.length) {
    for (let i = 0; i < paraInserir.length; i += 500) {
      const lote = paraInserir.slice(i, i + 500)
      const { error } = await dst.from('mensagens').insert(lote)
      if (error) { console.error(`mensagens insert (lote ${i}) falhou: ${error.message}`); stats.msgs_erro += lote.length }
    }
  }

  // ---- 5/6/7) SECUNDARIOS: anotacoes, timeline, visitas (via contato -> lead) ----
  const leadDoContato = (srcContactId: string | null): string | null => {
    if (!srcContactId) return null
    const fam = contactToFamilia.get(srcContactId)
    if (!fam || String(fam).startsWith('DRY:')) return null
    return famToLead2.get(fam) ?? null
  }
  const epoch = (v: unknown): number => { const d = new Date(String(v)); return isNaN(d.getTime()) ? 0 : d.getTime() }

  // 5) ANOTACOES (lead_notes -> anotacoes)
  const notes = await fetchAll(src, 'lead_notes', 'id,contact_id,headline,body,created_at')
  const dstNotas = new Set((await fetchAll(dst, 'anotacoes', 'lead_id,criado_em')).map((r) => `${r.lead_id}|${epoch(r.criado_em)}`))
  const notasInserir: Row[] = []
  for (const nt of notes) {
    const lead = leadDoContato(nt.contact_id); if (!lead) { stats.anotacoes_sem_lead++; continue }
    if (dstNotas.has(`${lead}|${epoch(nt.created_at)}`)) { stats.anotacoes_ja_existem++; continue }
    const conteudo = (nt.headline ? `${nt.headline}\n${nt.body ?? ''}` : (nt.body ?? '')).trim()
    if (!conteudo) continue
    notasInserir.push({ lead_id: lead, conteudo, criado_em: nt.created_at }); stats.anotacoes_novas++
  }
  if (APPLY) for (let i = 0; i < notasInserir.length; i += 500) {
    const { error } = await dst.from('anotacoes').insert(notasInserir.slice(i, i + 500))
    if (error) { console.error('anotacoes falhou:', error.message); stats.anotacoes_erro += Math.min(500, notasInserir.length - i) }
  }

  // 6) TIMELINE (crm_lead_activities -> eventos_timeline)
  const acts = await fetchAll(src, 'crm_lead_activities', 'id,contact_id,type,payload,metadata,performed_at,created_at')
  const dstEv = new Set((await fetchAll(dst, 'eventos_timeline', 'lead_id,criado_em,tipo')).map((r) => `${r.lead_id}|${epoch(r.criado_em)}|${r.tipo}`))
  const eventosInserir: Row[] = []
  for (const a of acts) {
    const lead = leadDoContato(a.contact_id); if (!lead) { stats.eventos_sem_lead++; continue }
    const tipo = EVENTO_TIPO_MAP[String(a.type)]
    if (!tipo) { stats.eventos_ignorados_telemetria++; continue }
    const criado = a.performed_at ?? a.created_at
    if (dstEv.has(`${lead}|${epoch(criado)}|${tipo}`)) { stats.eventos_ja_existem++; continue }
    const p = a.payload
    const descricao = (p && typeof p === 'object')
      ? String(p.descricao ?? p.title ?? p.message ?? JSON.stringify(p)).slice(0, 500)
      : String(p ?? a.type ?? '')
    eventosInserir.push({ lead_id: lead, tipo, descricao, metadados: a.metadata ?? a.payload ?? null, criado_em: criado }); stats.eventos_novos++
  }
  if (APPLY) for (let i = 0; i < eventosInserir.length; i += 500) {
    const { error } = await dst.from('eventos_timeline').insert(eventosInserir.slice(i, i + 500))
    if (error) { console.error('eventos_timeline falhou:', error.message); stats.eventos_erro += Math.min(500, eventosInserir.length - i) }
  }

  // 7) VISITAS (calendar_appointments -> tarefas). Carrega google_event_id p/ nao
  // recriar no Google (assume mesma conta/calendario — confirmar).
  const appts = await fetchAll(src, 'calendar_appointments', 'id,title,starts_at,status,contact_id,google_event_id')
  const dstVisitaGEvt = new Set((await fetchAll(dst, 'tarefas', 'google_event_id')).map((r) => r.google_event_id).filter(Boolean))
  const tarefasInserir: Row[] = []
  for (const ap of appts) {
    const lead = leadDoContato(ap.contact_id); if (!lead) { stats.visitas_sem_lead++; continue }
    if (ap.google_event_id && dstVisitaGEvt.has(ap.google_event_id)) { stats.visitas_ja_existem++; continue }
    const concluida = ['completed', 'no_show', 'cancelled'].includes(String(ap.status))
    tarefasInserir.push({ lead_id: lead, titulo: ap.title ?? 'Visita', tipo: 'visita', data_hora: ap.starts_at, concluida, status: VISITA_STATUS_MAP[String(ap.status)] ?? 'agendada', google_event_id: ap.google_event_id ?? null }); stats.visitas_novas++
  }
  if (APPLY) for (let i = 0; i < tarefasInserir.length; i += 500) {
    const { error } = await dst.from('tarefas').insert(tarefasInserir.slice(i, i + 500))
    if (error) { console.error('tarefas falhou:', error.message); stats.visitas_erro += Math.min(500, tarefasInserir.length - i) }
  }

  console.log('RESUMO:')
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(28)} ${v}`)
  console.log(`\n${APPLY ? '✅ Aplicado no crm@zdarzt.' : 'ℹ️  DRY-RUN — nada foi escrito. Rode com --apply para aplicar.'}\n`)
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1) })
