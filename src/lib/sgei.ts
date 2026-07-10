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
