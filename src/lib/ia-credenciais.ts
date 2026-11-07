import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { createServerAdminClient } from '@/lib/supabase-server'
import { aguardarVagaIA, chaveRpm, type PrioridadeIA } from '@/lib/ia-rpm'

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
export async function resolverCredencial(
  agente: 'sara' | 'salomao' | 'maestro',
  db: SupaAdmin,
  credencialId?: string | null
): Promise<CredResolvida> {
  const col = agente === 'salomao' ? 'salomao_credencial_id' : 'sara_credencial_id'
  try {
    let credId = credencialId ?? null
    if (!credId) {
      const { data: cfg } = await db.from('config_ia').select(col).eq('id', 1).maybeSingle()
      credId = (cfg as Record<string, string | null> | null)?.[col] ?? null
    }
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

// Erro transitório do provedor (vale repetir): 429/5xx ou mensagem de sobrecarga.
// O Gemini responde 503 "high demand / UNAVAILABLE" em picos; sem repetir, um
// 503 passageiro derruba o turno inteiro da Sara (e a extração de ficha, e o
// follow-up — todos passam por aqui).
function ehErroTransiente(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return /overloaded|unavailable|high demand|rate limit|timeout|timed out|econnreset|etimedout|socket hang up|\b50[234]\b|try again/.test(msg)
}

// Repete a chamada em erro transitório, com backoff exponencial + jitter.
// 3 tentativas no total (~0,6s e ~1,2s de espera) — cabe no maxDuration de 300s
// dos webhooks. Erro definitivo (4xx de verdade, 404) não repete.
// 429 (cota por minuto do Gemini grátis) pede espera MAIOR que 503: a janela é de 60s,
// então 0,6s não adianta — espera 5s e 10s. 503/rede segue no backoff curto.
export function ehRateLimit(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status
  if (status === 429) return true
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return /\b429\b|rate limit|resource_exhausted|quota/.test(msg)
}

export function esperaRetry(e: unknown, i: number): number {
  return ehRateLimit(e) ? 5000 * 2 ** i + Math.random() * 1000 : 600 * 2 ** i + Math.random() * 300
}

async function comRetry<T>(fn: () => Promise<T>, tentativas = 3): Promise<T> {
  let ultimo: unknown
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn()
    } catch (e) {
      ultimo = e
      if (i === tentativas - 1 || !ehErroTransiente(e)) throw e
      if (ehRateLimit(e)) console.warn('[ia] 429 do provedor, aguardando para repetir')
      await new Promise((r) => setTimeout(r, esperaRetry(e, i)))
    }
  }
  throw ultimo
}

/**
 * O Gemini recusa pedido cujo último turno é do modelo (400 "Requests ending with a
 * model turn are not supported"). Se a conversa termina em 'assistant', fecha com um
 * turno de usuário neutro. Não mexe quando já termina em 'user'.
 */
export function garantirTurnoFinalUsuario(messages: Mensagem[]): Mensagem[] {
  if (messages[messages.length - 1]?.role !== 'assistant') return messages
  return [
    ...messages,
    { role: 'user', content: '[INSTRUÇÃO INTERNA DO SISTEMA] Continue a partir da conversa acima, sem repetir o que já foi dito, no formato pedido.' },
  ]
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
  params: {
    messages: Mensagem[]
    model: string
    maxTokens: number
    jsonMode?: boolean
    /** Credencial específica (ex.: a do roteador); sem ela, vale a do agente. */
    credencialId?: string | null
    /** Fila de RPM: 'alta' = turno de conversa; 'baixa' = trabalho de fundo (cede na rajada). */
    prioridade?: PrioridadeIA
    /** Rótulo para a métrica de chamadas (crm.ia_chamadas.origem). */
    origem?: string
    /** Modelo de reserva quando o principal cai por sobrecarga/timeout (config_ia.modelo_reserva). */
    modeloReserva?: string | null
  },
  supabase?: SupaAdmin
): Promise<string> {
  const db = supabase ?? createServerAdminClient()
  const { provedor, apiKey, baseUrl } = await resolverCredencial(agente, db, params.credencialId)

  // Só o Gemini tem o teto apertado do tier grátis; os outros provedores passam direto.
  // Cada tentativa (inclusive a repetição após 429) reserva a própria vaga.
  const reservar = async (model: string) => {
    if (provedor === 'gemini') {
      await aguardarVagaIA(db, chaveRpm(provedor, model), params.prioridade ?? 'normal', params.origem ?? agente)
    }
  }

  if (provedor === 'anthropic') {
    const anthropic = new Anthropic({ apiKey })
    const system = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const sys = params.jsonMode
      ? `${system}\n\nResponda SOMENTE com um objeto JSON válido, sem markdown nem texto fora do JSON.`.trim()
      : system || undefined
    const conv = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant', content: m.content }))
    const resp = await comRetry(() => anthropic.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      ...(sys ? { system: sys } : {}),
      messages: conv,
    }))
    const txt = resp.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    return params.jsonMode ? extrairJson(txt) : txt
  }

  // OpenAI-compatível (openai, gemini-via-google, openrouter, deepseek, requesty, custom)
  // maxRetries 0: o SDK repetiria por conta própria (2x) chamadas que a fila não conta;
  // quem repete é o comRetry, com o backoff certo para 429.
  // timeout 25s: o Gemini grátis, sob "high demand", às vezes não responde nem com erro
  // (testado 07/11: 30–45s pendurado no 3.8 Flash) — sem teto, o turno some no silêncio.
  const client = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0, timeout: 25_000 })
  const gerar = (model: string, tentativas: number) =>
    comRetry(async () => {
      await reservar(model)
      return client.chat.completions.create({
        model,
        max_tokens: params.maxTokens,
        ...(params.jsonMode && SUPORTA_JSON.has(provedor) ? { response_format: { type: 'json_object' as const } } : {}),
        messages: provedor === 'gemini' ? garantirTurnoFinalUsuario(params.messages) : params.messages,
      })
    }, tentativas)

  // Modelo reserva: o principal tenta UMA vez; se cair por sobrecarga/timeout/429, a
  // mesma resposta sai pelo reserva (com os retries normais). A família não espera o
  // Google desafogar — no pior caso recebe a resposta do modelo mais leve.
  const reserva = params.modeloReserva?.trim()
  let resp: Awaited<ReturnType<typeof gerar>>
  if (reserva && reserva !== params.model) {
    try {
      resp = await gerar(params.model, 1)
    } catch (e) {
      if (!ehErroTransiente(e)) throw e
      console.warn(`[ia] ${params.model} indisponível (${e instanceof Error ? e.message.slice(0, 120) : e}); usando reserva ${reserva}`)
      resp = await gerar(reserva, 3)
    }
  } else {
    resp = await gerar(params.model, 3)
  }
  const out =resp.choices[0]?.message?.content ?? ''
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
