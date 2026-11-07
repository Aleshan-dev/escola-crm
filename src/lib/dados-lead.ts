import { createServerAdminClient } from '@/lib/supabase-server'
import { chamarModeloIA } from '@/lib/ia-credenciais'
import type { SaraCriancaDados, SaraFamiliaDados } from '@/lib/sara'

// Persistência dos dados do lead extraídos da conversa (família + criança).
//
// INCIDENTE 2026-10-21: com o modelo da Sara trocado para Gemini, o campo
// `crianca_dados.idade` passou a vir como TEXTO ("2 anos", "4 anos"). O insert em
// crm.criancas (idade integer) falhava INTEIRO — nome, série, período e motivo
// junto — e o erro era engolido. Resultado: ~80% dos leads de out/26 sem criança,
// e a Sara perguntando de novo o que a família já tinha dito.
// Aqui: (1) a saída do modelo é normalizada antes de ir ao banco; (2) todo erro de
// gravação é logado; (3) um extrator dedicado completa o que a Sara deixou passar.

type SupaAdmin = ReturnType<typeof createServerAdminClient>

const NUMEROS_EXTENSO: Record<string, number> = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, 'tres': 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
}

function numeroDe(token: string): number | null {
  const t = token.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  if (/^\d+([.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'))
  return t in NUMEROS_EXTENSO ? NUMEROS_EXTENSO[t] : null
}

/**
 * Converte a idade que o modelo devolver (número, "2", "2 anos", "3 anos e 5 meses",
 * "9 meses", "1 ano e meio", 1.5) em anos completos + meses (0-11).
 */
export function normalizarIdade(
  idade: unknown,
  idadeMeses?: unknown
): { idade: number | null; idade_meses: number | null } {
  let anos: number | null = null
  let meses: number | null = null

  if (typeof idade === 'number' && Number.isFinite(idade)) {
    anos = idade
  } else if (typeof idade === 'string' && idade.trim()) {
    const s = idade.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    const mAnos = s.match(/([\w.,]+)\s*anos?\b/)
    const mMeses = s.match(/([\w.,]+)\s*m[eê]s(es)?\b/)
    if (mAnos) anos = numeroDe(mAnos[1])
    if (mMeses) meses = numeroDe(mMeses[1])
    if (mAnos && /\be\s+meio\b/.test(s)) meses = (meses ?? 0) + 6
    if (!mAnos && !mMeses) anos = numeroDe(s)
  }

  if (meses == null) {
    const m = typeof idadeMeses === 'number' ? idadeMeses : typeof idadeMeses === 'string' ? numeroDe(idadeMeses.replace(/\D+$/, '')) : null
    if (m != null && Number.isFinite(m)) meses = m
  }

  // Fração de ano (1.5) vira meses.
  if (anos != null && !Number.isInteger(anos)) {
    meses = (meses ?? 0) + Math.round((anos % 1) * 12)
    anos = Math.floor(anos)
  }
  if (meses != null) {
    meses = Math.round(meses)
    if (meses >= 12) {
      anos = (anos ?? 0) + Math.floor(meses / 12)
      meses = meses % 12
    }
    // Só meses (bebê): anos = 0, para a turma sair certa.
    if (anos == null) anos = 0
  }
  // Fora da faixa de educação infantil/fundamental é ruído do modelo.
  if (anos != null && (anos < 0 || anos > 17)) return { idade: null, idade_meses: null }
  return { idade: anos, idade_meses: meses }
}

/** Aceita "2024-03-15" ou "15/03/2024"; devolve ISO (YYYY-MM-DD) ou null. */
export function normalizarData(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const v = valor.trim()
  let y: number, m: number, d: number
  let r = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])]
  else if ((r = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])]
  else return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  if (dt.getTime() > Date.now()) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function texto(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

/**
 * Um nome de pessoa precisa ter ao menos uma LETRA. Nome de perfil do WhatsApp
 * costuma vir como emoji puro ("🌸", "🥰") ou só símbolos — isso NÃO é nome e
 * não deve virar nome_responsavel. "Família" tem letras, então é tratado como
 * placeholder à parte por quem chama.
 */
export function nomePessoaValido(v: unknown): v is string {
  return typeof v === 'string' && /\p{L}/u.test(v)
}

export type CriancaNormalizada = {
  nome?: string
  idade?: number
  idade_meses?: number
  data_nascimento?: string
  serie_desejada?: string
  periodo?: string
  motivo_busca?: string
}

/** Saída do modelo → só colunas válidas de crm.criancas, com os tipos certos. */
export function normalizarCrianca(cd: (SaraCriancaDados & { idade_meses?: unknown }) | null | undefined): CriancaNormalizada {
  if (!cd) return {}
  const out: CriancaNormalizada = {}
  const nome = texto(cd.nome)
  if (nome) out.nome = nome
  const { idade, idade_meses } = normalizarIdade(cd.idade, cd.idade_meses)
  if (idade != null) out.idade = idade
  if (idade_meses != null) out.idade_meses = idade_meses
  const nasc = normalizarData(cd.data_nascimento)
  if (nasc) out.data_nascimento = nasc
  const serie = texto(cd.serie_desejada)
  if (serie) out.serie_desejada = serie
  const periodo = texto(cd.periodo)
  if (periodo) out.periodo = periodo
  const motivo = texto(cd.motivo_busca)
  if (motivo) out.motivo_busca = motivo
  return out
}

const CAMPOS_FAMILIA = ['nome_responsavel', 'email', 'cep', 'rua', 'numero', 'bairro', 'cidade', 'estado'] as const

export function normalizarFamilia(fd: SaraFamiliaDados | null | undefined): Record<string, string> {
  if (!fd) return {}
  const out: Record<string, string> = {}
  for (const k of CAMPOS_FAMILIA) {
    const v = texto((fd as Record<string, unknown>)[k])
    if (v) out[k] = v
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) delete out.email
  return out
}

/**
 * Anti-alucinação do nome da criança. O modelo leve (gemini flash-lite) às vezes
 * INVENTA um nome quando a família não deu nenhum — no incidente Kauanr (2026-11-04)
 * cuspiu "Kianu" garblando o push "Kauanr E Rondi", e com sobrescrever=true isso ia
 * parar na ficha. Regra: o nome só vale se a família o escreveu em alguma mensagem.
 * Casa pelo nome inteiro OU por qualquer token "de gente" (>=3 letras) — cobre
 * "Ana Catarina e Guilherme" (gêmeos) sem exigir a string exata.
 */
export function nomeFoiDitoPelaFamilia(nome: string, mensagensFamilia: (string | null)[]): boolean {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const alvo = norm(nome).trim()
  if (!alvo) return false
  const corpus = norm(mensagensFamilia.filter(Boolean).join(' \u0001 '))
  if (!corpus.trim()) return false
  if (corpus.includes(alvo)) return true
  return alvo.split(/\s+/).some((tok) => tok.length >= 3 && new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(corpus))
}

/** Mantém só os campos que estão vazios no registro atual (não pisa em dado já gravado). */
function soVazios<T extends Record<string, unknown>>(novo: T, atual: Record<string, unknown> | null | undefined): Partial<T> {
  if (!atual) return novo
  return Object.fromEntries(
    Object.entries(novo).filter(([k]) => atual[k] == null || atual[k] === '' || atual[k] === 'A confirmar')
  ) as Partial<T>
}

/**
 * Grava família + criança do lead. `sobrescrever=true` (saída da Sara no turno)
 * atualiza o que vier; `false` (extrator de reserva/backfill) só preenche vazios.
 * Devolve o crianca_id (criado aqui, se não existia).
 */
export async function salvarDadosLead(
  supabase: SupaAdmin,
  args: {
    leadId: string
    familiaId: string
    criancaId: string | null
    familiaDados?: SaraFamiliaDados | null
    criancaDados?: (SaraCriancaDados & { idade_meses?: unknown }) | null
    sobrescrever: boolean
  }
): Promise<{ criancaId: string | null; alterados: string[] }> {
  const alterados: string[] = []

  let fam = normalizarFamilia(args.familiaDados)
  if (!args.sobrescrever && Object.keys(fam).length > 0) {
    const { data: atual } = await supabase.from('familias').select('*').eq('id', args.familiaId).maybeSingle()
    fam = soVazios(fam, atual) as Record<string, string>
  }
  if (Object.keys(fam).length > 0) {
    const { error } = await supabase.from('familias').update(fam).eq('id', args.familiaId)
    if (error) console.error('[dados-lead] update familias falhou', args.leadId, error.message, fam)
    else alterados.push(...Object.keys(fam).map((k) => `familia.${k}`))
  }

  let cri: CriancaNormalizada = normalizarCrianca(args.criancaDados)
  let criancaId = args.criancaId

  // Nome de criança que a família NUNCA escreveu não entra na ficha (ver
  // nomeFoiDitoPelaFamilia). Vale para o turno da Sara (sobrescrever=true) e para o
  // backfill — os dois passam por aqui. Sem nome válido, o insert cai em 'A confirmar'.
  if (cri.nome && cri.nome !== 'A confirmar') {
    const { data: msgsIn } = await supabase
      .from('mensagens')
      .select('conteudo')
      .eq('lead_id', args.leadId)
      .eq('direcao', 'in')
      .limit(100)
    if (!nomeFoiDitoPelaFamilia(cri.nome, (msgsIn || []).map((m) => m.conteudo as string | null))) {
      console.warn('[dados-lead] nome de criança descartado (não dito pela família)', args.leadId, cri.nome)
      delete cri.nome
    }
  }

  if (Object.keys(cri).length === 0) return { criancaId, alterados }

  if (criancaId) {
    if (!args.sobrescrever) {
      const { data: atual } = await supabase.from('criancas').select('*').eq('id', criancaId).maybeSingle()
      cri = soVazios(cri, atual)
      // idade e meses andam juntos: não grava meses avulsos sobre uma idade já existente.
      if (atual?.idade != null && cri.idade == null) delete cri.idade_meses
    }
    if (Object.keys(cri).length > 0) {
      const { error } = await supabase.from('criancas').update(cri).eq('id', criancaId)
      if (error) console.error('[dados-lead] update criancas falhou', args.leadId, error.message, cri)
      else alterados.push(...Object.keys(cri).map((k) => `crianca.${k}`))
    }
    return { criancaId, alterados }
  }

  const { data: nova, error } = await supabase
    .from('criancas')
    .insert({ familia_id: args.familiaId, nome: cri.nome || 'A confirmar', ...cri })
    .select('id')
    .single()
  if (error || !nova) {
    console.error('[dados-lead] insert criancas falhou', args.leadId, error?.message, cri)
    return { criancaId, alterados }
  }
  criancaId = nova.id
  const { error: errLead } = await supabase.from('leads').update({ crianca_id: criancaId }).eq('id', args.leadId)
  if (errLead) console.error('[dados-lead] vincular crianca ao lead falhou', args.leadId, errLead.message)
  alterados.push(...Object.keys(cri).map((k) => `crianca.${k}`))
  return { criancaId, alterados }
}

/** Faltam dados de descoberta que a conversa pode ter? */
function faltaAlgo(crianca: Record<string, unknown> | null | undefined): boolean {
  if (!crianca) return true
  const nome = crianca.nome as string | null
  return (
    !nome || nome === 'A confirmar' ||
    (crianca.idade == null && crianca.idade_meses == null) ||
    !crianca.serie_desejada || !crianca.periodo || !crianca.motivo_busca
  )
}

/**
 * Extrator dedicado: lê a conversa inteira e devolve só os dados que a FAMÍLIA
 * disse. Prompt curto e focado (o prompt da Sara tem 400+ linhas e o modelo
 * deixa o JSON de dados de lado quando está ocupado respondendo).
 */
export async function extrairDadosDaConversa(
  supabase: SupaAdmin,
  leadId: string
): Promise<{ familia_dados: SaraFamiliaDados | null; crianca_dados: (SaraCriancaDados & { idade_meses?: number }) | null }> {
  const [{ data: msgs }, { data: config }, { data: series }, { data: turnos }] = await Promise.all([
    supabase.from('mensagens').select('direcao, conteudo, criado_em').eq('lead_id', leadId)
      .order('criado_em', { ascending: false }).limit(60),
    supabase.from('config_ia').select('modelo, modelo_auxiliar').eq('id', 1).maybeSingle(),
    supabase.from('series').select('nome, faixa_etaria').eq('ativa', true).order('ordem'),
    supabase.from('turnos').select('nome').eq('ativo', true).order('ordem'),
  ])
  const conversa = (msgs || []).reverse()
    .filter((m) => m.conteudo)
    .map((m) => `${m.direcao === 'in' ? 'FAMÍLIA' : 'ESCOLA'}: ${m.conteudo}`)
    .join('\n')
  if (!conversa.includes('FAMÍLIA:')) return { familia_dados: null, crianca_dados: null }

  const sistema = `Você extrai dados cadastrais de uma conversa de WhatsApp entre uma escola de educação infantil e uma família interessada em matrícula.
Registre SOMENTE o que a FAMÍLIA disse ou confirmou. Nunca invente; campo não dito = null.
- nome: nome da criança (não do responsável).
- idade: anos completos (inteiro). idade_meses: meses além dos anos (0-11). "1 ano e meio" = idade 1, idade_meses 6. "9 meses" = idade 0, idade_meses 9.
- data_nascimento: só se dita, formato YYYY-MM-DD.
- serie_desejada: NOME EXATO de uma destas turmas, escolhida pela idade quando a idade foi dita: ${(series || []).map((s) => `${s.nome}${s.faixa_etaria ? ` (${s.faixa_etaria})` : ''}`).join('; ') || '(nenhuma)'}. Se a família citou a turma, use a citada.
- periodo: NOME EXATO de um destes turnos, se a família indicou (ex.: "o dia todo" = Integral): ${(turnos || []).map((t) => t.nome).join('; ') || '(nenhum)'}.
- motivo_busca: por que a família procura escola agora / o que busca (a "dor"), 1 frase curta com as palavras dela.
- nome_responsavel: nome de quem conversa, só se ela se apresentou. email: só se informado.
Se houver mais de uma criança, use a principal (a primeira citada).
Se a conversa não for de matrícula (fornecedor, candidato a vaga, spam), devolva tudo null.
Responda SOMENTE JSON: {"familia_dados":{"nome_responsavel":null,"email":null},"crianca_dados":{"nome":null,"idade":null,"idade_meses":null,"data_nascimento":null,"serie_desejada":null,"periodo":null,"motivo_busca":null}}`

  try {
    const raw = await chamarModeloIA(
      'sara',
      {
        messages: [
          { role: 'system', content: sistema },
          { role: 'user', content: conversa },
        ],
        // Tarefa de fundo: modelo auxiliar (cota por minuto separada da conversa) e prioridade baixa.
        model: config?.modelo_auxiliar?.trim() || config?.modelo?.trim() || 'gpt-4o',
        maxTokens: 400,
        jsonMode: true,
        prioridade: 'baixa',
        origem: 'ficha',
      },
      supabase
    )
    const parsed = JSON.parse(raw || '{}')
    return { familia_dados: parsed.familia_dados ?? null, crianca_dados: parsed.crianca_dados ?? null }
  } catch (e) {
    console.error('[dados-lead] extração falhou', leadId, e instanceof Error ? e.message : e)
    return { familia_dados: null, crianca_dados: null }
  }
}

/**
 * Rede de segurança pós-turno: se a ficha ainda tem buraco, roda o extrator e
 * preenche SÓ o que está vazio. Não pisa em edição manual da equipe.
 */
export async function completarDadosLead(supabase: SupaAdmin, leadId: string): Promise<string[]> {
  const { data: lead } = await supabase
    .from('leads')
    .select('id, familia_id, crianca_id, crianca:criancas(*), familia:familias(nome_responsavel)')
    .eq('id', leadId)
    .maybeSingle()
  if (!lead?.familia_id) return []
  const crianca = (Array.isArray(lead.crianca) ? lead.crianca[0] : lead.crianca) as Record<string, unknown> | null
  const familia = (Array.isArray(lead.familia) ? lead.familia[0] : lead.familia) as { nome_responsavel?: string | null } | null
  const nomeAtualInvalido = !nomePessoaValido(familia?.nome_responsavel)
  if (!faltaAlgo(crianca) && !nomeAtualInvalido) return []

  const ext = await extrairDadosDaConversa(supabase, leadId)
  if (!ext.familia_dados && !ext.crianca_dados) return []
  const { alterados } = await salvarDadosLead(supabase, {
    leadId,
    familiaId: lead.familia_id,
    criancaId: lead.crianca_id,
    // Nome do responsável já vem do WhatsApp; o extrator só completa e-mail.
    familiaDados: ext.familia_dados ? { email: ext.familia_dados.email } : null,
    criancaDados: ext.crianca_dados,
    sobrescrever: false,
  })

  // Se o nome gravado é inválido (emoji puro do perfil do WhatsApp) e a família
  // se apresentou na conversa, o extrator pega o nome real. soVazios não cobre
  // isso (emoji não é "vazio"), então gravamos direto.
  if (nomeAtualInvalido && nomePessoaValido(ext.familia_dados?.nome_responsavel)) {
    const { error } = await supabase
      .from('familias')
      .update({ nome_responsavel: ext.familia_dados!.nome_responsavel })
      .eq('id', lead.familia_id)
    if (!error) alterados.push('familia.nome_responsavel')
  }
  return alterados
}
