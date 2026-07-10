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
