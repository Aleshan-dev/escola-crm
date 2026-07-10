import { createClient } from '@supabase/supabase-js'

// Cliente somente-leitura do Supabase do SGEI (Escola Guardiã) — banco SEPARADO do CRM.
// Integração (não unificação): o CRM lê turmas/alunos/responsáveis do SGEI.
// Requer no ambiente do CRM: SGEI_SUPABASE_URL e SGEI_SUPABASE_SERVICE_KEY.
export function createSgeiClient() {
  const url = process.env.SGEI_SUPABASE_URL
  const key = process.env.SGEI_SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error('SGEI não configurado: defina SGEI_SUPABASE_URL e SGEI_SUPABASE_SERVICE_KEY no CRM.')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

export function sgeiConfigurado(): boolean {
  return !!(process.env.SGEI_SUPABASE_URL && process.env.SGEI_SUPABASE_SERVICE_KEY)
}

// ---------------------------------------------------------------------------
// Integração via Edge Function do SGEI (contrato oficial, header x-api-key).
// Requer no CRM: SGEI_API_KEY (e opcionalmente SGEI_API_URL para sobrescrever).
// ---------------------------------------------------------------------------
const SGEI_ENDPOINT =
  process.env.SGEI_API_URL || 'https://zdarztyghsnhbsusizko.supabase.co/functions/v1/crm-integracao'

export function sgeiApiConfigurado(): boolean {
  return !!process.env.SGEI_API_KEY
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sgeiApi<T = any>(body: object): Promise<T> {
  const key = process.env.SGEI_API_KEY
  if (!key) throw new Error('SGEI_API_KEY não configurada no CRM')
  const r = await fetch(SGEI_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`SGEI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json() as Promise<T>
}

export type CheckLead = { ja_responsavel: boolean; nome_responsavel?: string; vinculo_ativo?: boolean }

// Identifica se o número já é responsável de aluno. Nunca lança (falha silenciosa).
export async function checkLead(whatsapp: string): Promise<CheckLead | null> {
  try {
    return await sgeiApi<CheckLead>({ recurso: 'check_lead', whatsapp })
  } catch (e) {
    console.error('[sgei] check_lead falhou:', e instanceof Error ? e.message : e)
    return null
  }
}

// ---------------------------------------------------------------------------
// Identificação de responsável na ENTRADA de um contato (leitura direta da base
// do SGEI). Replica a normalização da RPC check_lead (últimos 11 dígitos =
// responsaveis.celular_norm) e ainda descobre a TURMA do aluno ativo, para
// posicionar o lead na coluna certa do funil "Matriculados".
// ---------------------------------------------------------------------------
export type ResponsavelSgei = {
  ja_responsavel: boolean
  nome?: string | null
  vinculo_ativo?: boolean
  turma_id?: string | null
  turma_nome?: string | null
  aluno_nome?: string | null
}

// Normaliza um celular BR para 11 dígitos (DDD + 9 + 8). Reconstrói o 9º dígito
// quando o WhatsApp manda o número no formato antigo (sem o 9), que é a causa
// clássica de não casar com o cadastro.
export function normalizarCelularBR(raw: string): string | null {
  let d = (raw || '').replace(/\D/g, '')
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2) // tira código do país
  if (d.length === 10) d = d.slice(0, 2) + '9' + d.slice(2) // DDD + 8 -> insere o 9
  if (d.length === 11) return d
  return d.length >= 11 ? d.slice(-11) : null
}

export async function identificarResponsavel(telefone: string): Promise<ResponsavelSgei | null> {
  if (!sgeiConfigurado()) return null
  const norm = normalizarCelularBR(telefone)
  if (!norm) return { ja_responsavel: false }
  try {
    const sgei = createSgeiClient()
    let { data: resp } = await sgei
      .from('responsaveis')
      .select('id, nome')
      .eq('celular_norm', norm)
      .limit(1)
      .maybeSingle()

    // Fallback: casa pelos últimos 8 dígitos (assinante), aceitando só se for único —
    // contorna variações residuais de DDD/9º dígito sem risco de falso positivo.
    if (!resp) {
      const suf8 = norm.slice(-8)
      const { data: r2 } = await sgei
        .from('responsaveis')
        .select('id, nome')
        .like('celular_norm', `%${suf8}`)
        .limit(2)
      if (r2 && r2.length === 1) resp = r2[0] as any
    }

    if (!resp) return { ja_responsavel: false }

    const { data: vinculos } = await sgei
      .from('aluno_responsavel')
      .select('alunos!inner(id, nome, status, turma_id, turmas(id, nome))')
      .eq('responsavel_id', (resp as any).id)

    let vinculo_ativo = false
    let turma_id: string | null = null
    let turma_nome: string | null = null
    let aluno_nome: string | null = null
    for (const v of (vinculos || []) as any[]) {
      const a = v.alunos
      if (a && a.status === 'ativo') {
        vinculo_ativo = true
        aluno_nome = a.nome ?? aluno_nome
        if (a.turma_id) {
          turma_id = a.turma_id
          turma_nome = a.turmas?.nome ?? null
          break // prefere um vínculo que já tenha turma definida
        }
      }
    }

    const primeiroNome = ((resp as any).nome || '').split(' ')[0] || (resp as any).nome
    return { ja_responsavel: true, nome: primeiroNome, vinculo_ativo, turma_id, turma_nome, aluno_nome }
  } catch (e) {
    console.error('[sgei] identificarResponsavel falhou:', e instanceof Error ? e.message : e)
    return null
  }
}

// Ocupação por turma (com vagas). Cache curto para não bater a cada mensagem.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ocupCache: { at: number; data: any } | null = null
const OCUP_TTL_MS = 3 * 60 * 1000
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOcupacao(): Promise<any | null> {
  if (_ocupCache && Date.now() - _ocupCache.at < OCUP_TTL_MS) return _ocupCache.data
  try {
    const data = await sgeiApi({ recurso: 'ocupacao' })
    _ocupCache = { at: Date.now(), data }
    return data
  } catch (e) {
    console.error('[sgei] ocupacao falhou:', e instanceof Error ? e.message : e)
    return _ocupCache?.data ?? null
  }
}
