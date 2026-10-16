import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { createServerAdminClient } from '@/lib/supabase-server'

// Credenciais de IA por provedor. A maioria usa o SDK da OpenAI (muda chave +
// baseURL); o Gemini entra pelo endpoint compatível-OpenAI do Google (sem SDK
// novo); só a Anthropic usa SDK próprio (formato de mensagens diferente).

export type Provedor = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'deepseek' | 'requesty' | 'custom'

export const PROVEDORES: { id: Provedor; nome: string; baseUrl: string | null; nativo?: 'anthropic' }[] = [
  { id: 'anthropic', nome: 'Anthropic (Claude)', baseUrl: null, nativo: 'anthropic' },
  { id: 'openai', nome: 'OpenAI (GPT)', baseUrl: null },
  { id: 'gemini', nome: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  { id: 'openrouter', nome: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'deepseek', nome: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'requesty', nome: 'Requesty', baseUrl: 'https://router.requesty.ai/v1' },
  { id: 'custom', nome: 'Compatível com OpenAI (custom)', baseUrl: null },
]

export const PROVEDORES_VALIDOS = PROVEDORES.map((p) => p.id)

export function baseUrlDe(provedor: Provedor, baseUrlInformado?: string | null): string | undefined {
  if (provedor === 'custom') return baseUrlInformado?.trim() || undefined
  return PROVEDORES.find((x) => x.id === provedor)?.baseUrl ?? undefined
}

// Provedores cujo endpoint aceita response_format json_object com confiança.
const SUPORTA_JSON = new Set<Provedor>(['openai', 'openrouter', 'deepseek', 'requesty', 'gemini'])

type SupaAdmin = ReturnType<typeof createServerAdminClient>
interface CredResolvida { provedor: Provedor; apiKey: string; baseUrl?: string }
export type Mensagem = { role: 'system' | 'user' | 'assistant'; content: string }

// O Maestro Guardião (chat de reorganização) não tem credencial própria: reusa a
// da Sara (fallback env). Evita migração/coluna nova no config_ia vivo.
async function resolverCredencial(agente: 'sara' | 'salomao' | 'maestro', db: SupaAdmin): Promise<CredResolvida> {
  const col = agente === 'salomao' ? 'salomao_credencial_id' : 'sara_credencial_id'
  try {
    const { data: cfg } = await db.from('config_ia').select(col).eq('id', 1).maybeSingle()
    const credId = (cfg as Record<string, string | null> | null)?.[col] ?? null
    if (credId) {
      const { data: cred } = await db.from('ia_credenciais').select('provedor, api_key, base_url').eq('id', credId).maybeSingle()
      if (cred?.api_key) {
        const provedor = cred.provedor as Provedor
        return { provedor, apiKey: cred.api_key, baseUrl: baseUrlDe(provedor, cred.base_url) }
      }
    }
  } catch {
    // coluna/tabela ausente → cai no env
  }
  return { provedor: 'openai', apiKey: process.env.OPENAI_API_KEY || '' }
}

/** Extrai um objeto JSON de um texto (remove cercas ```json e preâmbulos). */
export function extrairJson(texto: string): string {
  let t = texto.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const ini = t.indexOf('{')
  const fim = t.lastIndexOf('}')
  if (ini >= 0 && fim > ini) return t.slice(ini, fim + 1)
  return t
}

/**
 * Chamada unificada de modelo para um agente, usando a credencial escolhida
 * (fallback: OPENAI_API_KEY do env). Devolve o texto da resposta (o chamador
 * dá JSON.parse quando jsonMode). Anthropic usa SDK próprio; o resto, o da OpenAI.
 */
export async function chamarModeloIA(
  agente: 'sara' | 'salomao' | 'maestro',
  params: { messages: Mensagem[]; model: string; maxTokens: number; jsonMode?: boolean },
  supabase?: SupaAdmin
): Promise<string> {
  const db = supabase ?? createServerAdminClient()
  const { provedor, apiKey, baseUrl } = await resolverCredencial(agente, db)

  if (provedor === 'anthropic') {
    const anthropic = new Anthropic({ apiKey })
    const system = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const sys = params.jsonMode
      ? `${system}\n\nResponda SOMENTE com um objeto JSON válido, sem markdown nem texto fora do JSON.`.trim()
      : system || undefined
    const conv = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }))
    const resp = await anthropic.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      ...(sys ? { system: sys } : {}),
      messages: conv,
    })
    const txt = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    return params.jsonMode ? extrairJson(txt) : txt
  }

  // OpenAI-compatível (openai, gemini-via-google, openrouter, deepseek, requesty, custom)
  const client = new OpenAI({ apiKey, baseURL: baseUrl })
  const resp = await client.chat.completions.create({
    model: params.model,
    max_tokens: params.maxTokens,
    ...(params.jsonMode && SUPORTA_JSON.has(provedor) ? { response_format: { type: 'json_object' as const } } : {}),
    messages: params.messages,
  })
  const out = resp.choices[0]?.message?.content ?? ''
  return params.jsonMode ? extrairJson(out) : out
}

/** Valida a credencial fazendo uma chamada barata (models.list). */
export async function validarCredencial(
  provedor: Provedor,
  apiKey: string,
  baseUrl?: string | null
): Promise<{ ok: boolean; erro?: string }> {
  try {
    if (provedor === 'anthropic') {
      await new Anthropic({ apiKey }).models.list()
    } else {
      await new OpenAI({ apiKey, baseURL: baseUrlDe(provedor, baseUrl) }).models.list()
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message.slice(0, 300) : 'Falha ao validar' }
  }
}
