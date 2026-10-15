// Cliente do WAHA (WhatsApp HTTP API — https://waha.devlike.pro).
//
// PAPEL: motor ALTERNATIVO de DISPAROS não-oficiais (cobrança do Salomão +
// convites), no lugar do Evolution. Selecionado pela env WHATSAPP_PROVIDER=waha
// (ver src/lib/evolution.ts, que despacha por essa flag). Com a flag em
// 'evolution' (default), NADA aqui é chamado.
//
// CONFIG (URL/KEY/SESSION): resolvida do BANCO (crm.integracao_waha, editável na
// tela Configurações → WhatsApp Disparos) com FALLBACK para as env vars
// WAHA_API_URL / WAHA_API_KEY / WAHA_SESSION. A tabela tem RLS ligada e sem
// policies — só o service role a lê; a api_key nunca sai pela anon key.
//
// COMPATIBILIDADE DE RETORNO: os chamadores (salomao-dispatch, convites, o
// fallback do whatsapp-cloud) leem `sent?.key?.id`. Por isso os envios daqui
// devolvem a MESMA forma do Evolution: `{ key: { id } }`.
//
// ⚠️ TOPOLOGIA DE NÚMERO: WAHA é WhatsApp Web não-oficial. NUNCA aponte a sessão
// para o número que está na Cloud API (CoEx) — a sessão não-oficial desregistra
// o número da Cloud (erro 133010, o apagão de 20/08). Disparos vão de um CHIP
// SEPARADO do número de atendimento.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type WahaConfig = { url: string; key: string; session: string }

// Cache curto: o loop de disparos chama sendText/sendMedia por mensagem; sem
// cache seria uma leitura ao banco por envio. TTL baixo para refletir edições
// da tela em segundos.
let _cache: { cfg: WahaConfig; exp: number } | null = null
const TTL_MS = 30_000

// Zera o cache — chamado após salvar a config pela tela.
export function invalidarWahaConfig() {
  _cache = null
}

async function lerConfigBanco(): Promise<Partial<WahaConfig>> {
  try {
    const { createServerAdminClient } = await import('@/lib/supabase-server')
    const supabase = createServerAdminClient()
    const { data } = await supabase
      .from('integracao_waha')
      .select('api_url, api_key, session')
      .eq('id', 1)
      .maybeSingle<{ api_url: string | null; api_key: string | null; session: string | null }>()
    if (!data) return {}
    return {
      url: data.api_url || undefined,
      key: data.api_key || undefined,
      session: data.session || undefined,
    }
  } catch {
    // Banco fora / tabela ausente: cai no fallback de env.
    return {}
  }
}

// Config efetiva: banco > env. `url` sem barra final; `session` default 'default'.
export async function getWahaConfig(): Promise<WahaConfig> {
  if (_cache && _cache.exp > Date.now()) return _cache.cfg
  const banco = await lerConfigBanco()
  const cfg: WahaConfig = {
    url: (banco.url || process.env.WAHA_API_URL || '').replace(/\/+$/, ''),
    key: banco.key || process.env.WAHA_API_KEY || '',
    session: banco.session || process.env.WAHA_SESSION || 'default',
  }
  _cache = { cfg, exp: Date.now() + TTL_MS }
  return cfg
}

// true se a config WAHA ativa (banco ou env) tem URL + chave.
export async function wahaConfigurado(): Promise<boolean> {
  const { url, key } = await getWahaConfig()
  return !!(url && key)
}

// Brasil e o 9º dígito no JID do WhatsApp — REGRA POR REGIÃO, não global.
// Um celular em E.164 completo tem 13 díg (55 + DDD + 9 + 8). Se a conta do
// WhatsApp existe SEM o 9, mandar COM o 9 dá "no LID found ...@s.whatsapp.net";
// se existe COM o 9, mandar SEM dá o mesmo erro. O 9 só é OPCIONAL (contas
// antigas sem ele) nas regiões de DDD >= 31 — a base da escola é Acre (DDD 68),
// por isso removê-lo funcionava lá. Nas capitais de DDD <= 27 (SP=11..19, RJ=21..24,
// ES=27...) o 9 é OBRIGATÓRIO: remover quebra (foi o caso da DDD 12). Por isso
// só removemos quando DDD >= 31. O caminho AUTORITATIVO é resolverChatId (abaixo),
// que pergunta ao WAHA qual forma tem conta; esta função é só o fallback offline.
function dddDe(digitos: string): number | null {
  if (digitos.length >= 12 && digitos.startsWith('55')) return parseInt(digitos.slice(2, 4), 10)
  return null
}

export function normalizarJidBR(digitos: string): string {
  if (digitos.length === 13 && digitos.startsWith('55') && digitos[4] === '9') {
    const ddd = dddDe(digitos)
    // Só remove o 9 nas regiões onde contas antigas podem não tê-lo (DDD >= 31).
    if (ddd != null && ddd >= 31) return digitos.slice(0, 4) + digitos.slice(5)
  }
  return digitos
}

// Número E.164 puro ('5568984078651') → chatId do WAHA ('556884078651@c.us'),
// já com o 9º dígito removido no caso BR. Aceita idempotentemente um chatId
// já formatado. SÍNCRONO e heurístico — o envio usa resolverChatId, que confirma
// com o servidor antes; isto serve para chamadas fora do caminho de envio.
export function numeroParaChatId(numero: string): string {
  if (numero.includes('@')) return numero
  const digitos = normalizarJidBR(numero.replace(/\D/g, ''))
  return `${digitos}@c.us`
}

// Formas candidatas de um número BR: como veio E a variante com/sem o 9º dígito.
// A ordem prioriza a forma "como está no banco", depois a alternativa.
function candidatosBR(digitos: string): string[] {
  const out = [digitos]
  if (digitos.length === 13 && digitos.startsWith('55') && digitos[4] === '9') {
    out.push(digitos.slice(0, 4) + digitos.slice(5)) // sem o 9
  } else if (digitos.length === 12 && digitos.startsWith('55')) {
    out.push(digitos.slice(0, 4) + '9' + digitos.slice(4)) // com o 9
  }
  return out
}

// Resolve o chatId AUTORITATIVO perguntando ao WAHA qual forma (com/sem 9) tem
// conta no WhatsApp (endpoint check-exists). Evita o chute do 9º dígito, que
// varia por região. Cacheia por número (o loop de disparos manda várias msgs).
// Se o check-exists estiver indisponível, cai no fallback heurístico regional.
const _chatIdCache = new Map<string, string>()

export async function resolverChatId(numero: string): Promise<string> {
  if (numero.includes('@')) return numero
  const digitos = numero.replace(/\D/g, '')
  const cached = _chatIdCache.get(digitos)
  if (cached) return cached

  const cfg = await getWahaConfig()
  const s = encodeURIComponent(cfg.session)
  const headers = { 'X-Api-Key': cfg.key }

  for (const cand of candidatosBR(digitos)) {
    // Duas formas de rota (variam por versão do WAHA): global e por-sessão.
    const urls = [
      `${cfg.url}/api/contacts/check-exists?phone=${cand}&session=${s}`,
      `${cfg.url}/api/${s}/contacts/check-exists?phone=${cand}`,
    ]
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers, cache: 'no-store' })
        if (!r.ok) continue
        const j: any = await r.json()
        if (j?.numberExists && typeof j?.chatId === 'string' && j.chatId.includes('@')) {
          _chatIdCache.set(digitos, j.chatId)
          return j.chatId
        }
        // Respondeu que NÃO existe: não adianta tentar a mesma forma na outra rota.
        if (j && j.numberExists === false) break
      } catch { /* tenta a próxima rota/forma */ }
    }
  }

  // Fallback: check-exists fora do ar → heurística regional (não trava o envio).
  return `${normalizarJidBR(digitos)}@c.us`
}

// Resolve o número REAL por trás de um endereço @lid (identificador opaco novo do
// WhatsApp). O evento do webhook às vezes traz só `from: "<lid>@lid"`, sem o
// telefone — então perguntamos ao WAHA, que conhece o mapa. Retorna os dígitos do
// telefone (ou os dígitos do próprio lid, se não resolver) + `via` (para debug).
const _lidCache = new Map<string, string>()
const soDigitos = (v: string) => (v || '').split('@')[0].replace(/\D/g, '')

export async function resolverTelefoneWaha(from: string): Promise<{ telefone: string; via: string }> {
  const raw = from || ''
  if (raw.includes('@c.us')) return { telefone: soDigitos(raw), via: 'c.us' }
  if (!raw.includes('@lid')) return { telefone: soDigitos(raw), via: 'raw' }
  if (_lidCache.has(raw)) return { telefone: _lidCache.get(raw)!, via: 'cache' }

  const cfg = await getWahaConfig()
  const s = encodeURIComponent(cfg.session)
  const headers = { 'X-Api-Key': cfg.key }
  const lidEnc = encodeURIComponent(raw)

  // Extrai um telefone (@c.us) de várias formas de resposta possíveis.
  const extrair = (j: any): string | null => {
    const cand = j?.pn || j?.phoneNumber || j?.number || j?.id?._serialized || j?.id || j?.jid
    const str = typeof cand === 'string' ? cand : ''
    if (!str || str.includes('@lid')) return null
    const d = soDigitos(str)
    return d.length >= 8 ? d : null
  }

  // Candidatos de endpoint (variam por versão do WAHA). O primeiro que resolver vence.
  const urls = [
    `${cfg.url}/api/${s}/lids/${lidEnc}`,
    `${cfg.url}/api/${s}/contacts?contactId=${lidEnc}`,
    `${cfg.url}/api/contacts?session=${s}&contactId=${lidEnc}`,
  ]
  const vias = ['lids', 'contacts', 'contacts-legacy']

  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await fetch(urls[i], { headers, cache: 'no-store' })
      if (!r.ok) continue
      const tel = extrair(await r.json())
      if (tel) {
        _lidCache.set(raw, tel)
        return { telefone: tel, via: vias[i] }
      }
    } catch { /* tenta o próximo */ }
  }

  return { telefone: soDigitos(raw), via: 'lid-fallback' }
}

// Resolve o CONTATO (telefone real + nome do WhatsApp) por trás de um `from` que
// pode ser @lid. O nome vem da API de contatos do WAHA (o painel mostra os nomes,
// então a API tem — só varia o campo por engine). Defensivo: tenta vários campos.
export async function resolverContatoWaha(from: string): Promise<{ telefone: string; nome: string | null; via: string }> {
  const { telefone, via } = await resolverTelefoneWaha(from)
  let nome: string | null = null
  try {
    const cfg = await getWahaConfig()
    const s = encodeURIComponent(cfg.session)
    const headers = { 'X-Api-Key': cfg.key }
    const ids = Array.from(new Set([from, `${telefone}@c.us`]))
    const urls: string[] = []
    for (const id of ids) {
      urls.push(`${cfg.url}/api/${s}/contacts?contactId=${encodeURIComponent(id)}`)
      urls.push(`${cfg.url}/api/contacts?session=${s}&contactId=${encodeURIComponent(id)}`)
    }
    for (const u of urls) {
      try {
        const r = await fetch(u, { headers, cache: 'no-store' })
        if (!r.ok) continue
        const j: any = await r.json()
        const c = Array.isArray(j) ? j[0] : j
        const cand =
          c?.name || c?.pushname || c?.pushName || c?.shortName ||
          c?.notify || c?.notifyName || c?.verifiedName || c?.formattedName
        if (typeof cand === 'string' && cand.trim() && !cand.includes('@')) {
          nome = cand.trim()
          break
        }
      } catch { /* tenta o próximo */ }
    }
  } catch { /* sem nome */ }
  return { telefone, nome, via }
}

// O id da mensagem no WAHA varia por engine: às vezes `id` é string, às vezes
// um objeto com `_serialized`. Normaliza para uma string (ou null).
function extrairId(j: any): string | null {
  const id = j?.id
  if (!id) return j?.key?.id ?? null
  if (typeof id === 'string') return id
  return id?._serialized ?? id?.id ?? null
}

async function post(cfg: WahaConfig, path: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${cfg.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': cfg.key },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`WAHA ${path} falhou (${r.status}): ${t.slice(0, 300)}`)
  }
  return r.json()
}

// Envio de texto. Devolve `{ key: { id } }` (forma do Evolution).
export async function wahaSendText(numero: string, texto: string): Promise<{ key: { id: string | null } }> {
  const cfg = await getWahaConfig()
  const j = await post(cfg, '/api/sendText', {
    session: cfg.session,
    chatId: await resolverChatId(numero),
    text: texto,
  })
  return { key: { id: extrairId(j) } }
}

// Envio de mídia por URL (o WAHA baixa e envia — igual ao Evolution, que também
// recebe `media` como URL). Imagem → /api/sendImage; resto → /api/sendFile.
export async function wahaSendMedia(
  numero: string,
  opts: { media: string; fileName: string; caption?: string; mediatype?: string; mimetype?: string }
): Promise<{ key: { id: string | null } }> {
  const cfg = await getWahaConfig()
  const ehImagem = opts.mediatype === 'image' || (opts.mimetype || '').startsWith('image/')
  const path = ehImagem ? '/api/sendImage' : '/api/sendFile'
  const j = await post(cfg, path, {
    session: cfg.session,
    chatId: await resolverChatId(numero),
    file: {
      url: opts.media,
      filename: opts.fileName,
      mimetype: opts.mimetype || 'application/octet-stream',
    },
    ...(opts.caption ? { caption: opts.caption } : {}),
  })
  return { key: { id: extrairId(j) } }
}

// Estado da sessão, normalizado para a MESMA forma do Evolution (`{ state }`
// com 'open'|'connecting'|'close'), para o guardião/status seguirem coerentes.
// Nunca lança: se a API está fora, isso JÁ é o diagnóstico.
export async function wahaConnectionState(): Promise<{ ok: boolean; payload: unknown; erro?: string }> {
  try {
    const cfg = await getWahaConfig()
    const r = await fetch(`${cfg.url}/api/sessions/${encodeURIComponent(cfg.session)}`, {
      headers: { 'X-Api-Key': cfg.key },
      signal: AbortSignal.timeout(10_000),
    })
    // 404 = sessão ainda não criada. Não é erro de rede: é "parada".
    if (r.status === 404) {
      return { ok: true, payload: { state: 'close', wahaStatus: 'STOPPED' } }
    }
    if (!r.ok) {
      return { ok: false, payload: null, erro: `WAHA session HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }
    }
    const j: any = await r.json()
    const status: string = j?.status || 'UNKNOWN'
    // WORKING = conectado; STARTING/SCAN_QR_CODE = subindo; resto = caído.
    const state =
      status === 'WORKING' ? 'open'
      : status === 'STARTING' || status === 'SCAN_QR_CODE' ? 'connecting'
      : 'close'
    return { ok: true, payload: { state, wahaStatus: status } }
  } catch (e) {
    return { ok: false, payload: null, erro: e instanceof Error ? e.message : 'falha de rede' }
  }
}
