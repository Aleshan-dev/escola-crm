/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI, { toFile } from 'openai'
import { randomUUID } from 'crypto'

// Processamento de mídia recebida no WhatsApp (Evolution): baixa o arquivo,
// transcreve áudio (Whisper) e descreve imagem (gpt-4o visão). Devolve um texto
// que representa a mídia para a Sara entender e responder.

const URL = process.env.EVOLUTION_API_URL!
const KEY = process.env.EVOLUTION_API_KEY!
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME!

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

type EvolutionData = {
  key?: Record<string, unknown>
  message?: Record<string, any>
}

// Baixa a mídia da mensagem como base64 via Evolution.
async function baixarMidiaBase64(data: EvolutionData): Promise<{ base64: string; mimetype: string } | null> {
  try {
    const r = await fetch(`${URL}/chat/getBase64FromMediaMessage/${encodeURIComponent(INSTANCE)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY },
      body: JSON.stringify({ message: { key: data.key }, convertToMp4: false }),
    })
    if (!r.ok) {
      console.error('[midia] download falhou:', r.status, await r.text())
      return null
    }
    const j: any = await r.json()
    const base64: string | null = j?.base64 || j?.media || null
    const mimetype: string = j?.mimetype || j?.mimeType || ''
    if (!base64) return null
    return { base64, mimetype }
  } catch (e) {
    console.error('[midia] erro no download:', e)
    return null
  }
}

// Extensão de arquivo a partir do mimetype (ou do nome original, se houver).
function extDaMidia(mimetype: string, filename?: string): string {
  if (filename && filename.includes('.')) {
    const e = filename.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (e) return e.slice(0, 8)
  }
  const m = (mimetype || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('pdf')) return 'pdf'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('mp4')) return 'mp4'
  if (m.includes('wav')) return 'wav'
  return 'bin'
}

// Salva o arquivo original (base64) no bucket privado 'midias' e devolve o CAMINHO
// (não a URL) — o chat gera uma URL assinada sob autenticação via /api/midia.
export async function salvarMidiaStorage(
  supabase: any,
  file: { base64: string; mimetype: string; filename?: string }
): Promise<string | null> {
  try {
    const buf = Buffer.from(file.base64, 'base64')
    const ext = extDaMidia(file.mimetype, file.filename)
    const hoje = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (organização)
    const path = `${hoje}/${randomUUID()}.${ext}`
    const { error } = await supabase.storage.from('midias').upload(path, buf, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false,
    })
    if (error) {
      console.error('[midia] upload storage falhou:', error.message)
      return null
    }
    return path
  } catch (e) {
    console.error('[midia] erro no upload storage:', e)
    return null
  }
}

// ── Gemini nativo: lê áudio, imagem e PDF numa só credencial ────────────────
// A credencial (hoje Gemini) vem do banco, como o resto da IA — não do
// OPENAI_API_KEY fixo. Modelos '-lite' nem sempre aceitam áudio/PDF, então
// mídia usa um flash completo por padrão (MIDIA_MODELO_GEMINI sobrescreve).
const MODELO_MIDIA_PADRAO = 'gemini-flash-latest'
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models'

function limparMime(mimetype: string): string {
  return (mimetype || '').split(';')[0].trim().toLowerCase()
}

// Só mandamos ao Gemini o que ele lê como inline_data com segurança.
function geminiLe(mime: string): boolean {
  return mime.startsWith('image/') || mime.startsWith('audio/') || mime === 'application/pdf'
}

function instrucaoMidia(tipo: 'audio' | 'imagem' | 'documento'): string {
  if (tipo === 'audio') {
    return 'Transcreva integralmente este áudio em português do Brasil. Responda SOMENTE com a transcrição, sem comentários, sem aspas e sem rótulos.'
  }
  if (tipo === 'imagem') {
    return 'Você analisa imagens enviadas por responsáveis no WhatsApp de uma escola de educação infantil. Em 1-2 frases, em português, diga objetivamente o que a imagem mostra (ex.: documento como RG, CPF, comprovante de residência ou de pagamento; print de conversa; foto da criança). Se houver texto legível relevante (valor, data, banco), inclua-o. Nunca invente informações.'
  }
  return 'Você analisa um documento enviado por um responsável no WhatsApp de uma escola de educação infantil. Em português, resuma objetivamente o conteúdo e extraia os dados relevantes: se for comprovante de pagamento, cite valor, data e banco/forma; se for contrato, diga se está assinado e os pontos principais; se for lista/material, liste os itens. Seja conciso (até ~6 linhas). Nunca invente informações que não estejam no documento.'
}

// Resolve o modelo de mídia: env > config_ia.modelo (se não for '-lite') > padrão.
async function modeloMidiaGemini(supabase: any): Promise<string> {
  if (process.env.MIDIA_MODELO_GEMINI) return process.env.MIDIA_MODELO_GEMINI
  try {
    const { data } = await supabase.from('config_ia').select('modelo').eq('id', 1).maybeSingle()
    const m = (data?.modelo || '').trim()
    if (m.startsWith('gemini') && !m.includes('lite')) return m
  } catch {
    // config ausente → padrão
  }
  return MODELO_MIDIA_PADRAO
}

async function interpretarComGemini(
  apiKey: string,
  model: string,
  tipo: 'audio' | 'imagem' | 'documento',
  base64: string,
  mime: string
): Promise<string | null> {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: instrucaoMidia(tipo) },
          { inline_data: { mime_type: mime, data: base64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: tipo === 'audio' ? 1200 : 500 },
  }
  const r = await fetch(`${GEMINI_API}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    console.error('[midia-gemini] falhou:', model, r.status, (await r.text()).slice(0, 300))
    return null
  }
  const j: any = await r.json()
  const txt: string = (j?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p?.text || '')
    .join('')
    .trim()
  return txt || null
}

// ── Fallback OpenAI (só se OPENAI_API_KEY existir) ──────────────────────────
export async function transcreverAudio(base64: string, mimetype: string): Promise<string | null> {
  try {
    const buffer = Buffer.from(base64, 'base64')
    const ext = mimetype.includes('mp4') || mimetype.includes('m4a')
      ? 'm4a'
      : mimetype.includes('mpeg') || mimetype.includes('mp3')
        ? 'mp3'
        : 'ogg'
    const file = await toFile(buffer, `audio.${ext}`, { type: mimetype || 'audio/ogg' })
    const tr = await getOpenAI().audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'pt',
    })
    return tr.text?.trim() || null
  } catch (e) {
    console.error('[midia] transcrição (openai) falhou:', e)
    return null
  }
}

export async function descreverImagem(base64: string, mimetype: string): Promise<string | null> {
  try {
    const dataUrl = `data:${mimetype || 'image/jpeg'};base64,${base64}`
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [
        { role: 'system', content: instrucaoMidia('imagem') },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'O que é esta imagem?' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ] as any,
        },
      ],
    })
    return resp.choices[0]?.message?.content?.trim() || null
  } catch (e) {
    console.error('[midia] descrição de imagem (openai) falhou:', e)
    return null
  }
}

async function descreverPdfOpenAI(base64: string, filename?: string): Promise<string | null> {
  try {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [
        { role: 'system', content: instrucaoMidia('documento') },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Resuma este documento.' },
            {
              type: 'file',
              file: { filename: filename || 'documento.pdf', file_data: `data:application/pdf;base64,${base64}` },
            },
          ] as any,
        },
      ],
    })
    return resp.choices[0]?.message?.content?.trim() || null
  } catch (e) {
    console.error('[midia] leitura de PDF (openai) falhou:', e)
    return null
  }
}

/**
 * Interpreta uma mídia já baixada (base64) e devolve um texto para a Sara.
 * Caminho único dos três canais (WAHA, Cloud, Evolution). Lê áudio, imagem e
 * PDF pelo Gemini (credencial do banco); se falhar e houver OPENAI_API_KEY,
 * cai no Whisper/gpt-4o; falha real vira alerta (nunca degrada em silêncio).
 */
export async function interpretarMidia(
  tipo: 'audio' | 'imagem' | 'documento',
  base64: string,
  mimetype: string,
  caption?: string,
  filename?: string
): Promise<string> {
  const mime = limparMime(mimetype)
  const ehImagem = tipo === 'imagem' || mime.startsWith('image/')
  const ehAudio = tipo === 'audio' || mime.startsWith('audio/')
  const ehPdf = mime === 'application/pdf'
  const lerComModelo = ehAudio || ehImagem || ehPdf

  const { createServerAdminClient } = await import('@/lib/supabase-server')
  const supabase = createServerAdminClient()

  let bruto: string | null = null
  let tentouModelo = false

  // 1) Gemini nativo (credencial do banco).
  if (lerComModelo && geminiLe(mime)) {
    try {
      const { resolverCredencial } = await import('@/lib/ia-credenciais')
      const cred = await resolverCredencial('sara', supabase)
      if (cred.provedor === 'gemini' && cred.apiKey) {
        tentouModelo = true
        const model = await modeloMidiaGemini(supabase)
        const tg = ehAudio ? 'audio' : ehImagem ? 'imagem' : 'documento'
        bruto = await interpretarComGemini(cred.apiKey, model, tg, base64, mime)
      }
    } catch (e) {
      console.error('[midia] gemini indisponível:', e)
    }
  }

  // 2) Fallback OpenAI (só se a chave existir).
  if (!bruto && lerComModelo && process.env.OPENAI_API_KEY) {
    tentouModelo = true
    bruto = ehAudio
      ? await transcreverAudio(base64, mime)
      : ehImagem
        ? await descreverImagem(base64, mime)
        : await descreverPdfOpenAI(base64, filename)
  }

  // 3) Falha real (tentou ler e não conseguiu): alerta, nunca degrada calado.
  if (tentouModelo && !bruto) {
    try {
      const { registrarAlerta } = await import('@/lib/alertas')
      await registrarAlerta(supabase, 'midia/interpretar', `Não consegui interpretar ${tipo} (${mime || 'sem mimetype'}).`)
    } catch {
      // alerta é best-effort
    }
  }

  // ── Monta o texto para a Sara ──────────────────────────────────────────────
  if (ehAudio) {
    return bruto || '[O responsável enviou um áudio que não consegui transcrever. Peça, com gentileza, que repita por texto.]'
  }

  if (ehImagem) {
    const corpo = bruto
      ? `[O responsável enviou ${tipo === 'documento' ? 'um documento (imagem)' : 'uma imagem'}. Conteúdo: ${bruto}]`
      : '[O responsável enviou uma imagem que não consegui interpretar.]'
    return caption ? `${caption}\n${corpo}` : corpo
  }

  if (ehPdf) {
    const nome = filename || 'documento.pdf'
    const corpo = bruto
      ? `[O responsável enviou o documento "${nome}". Conteúdo: ${bruto}]`
      : `[O responsável enviou um documento ("${nome}") que não consegui ler. Confirme o recebimento com gentileza e diga que a equipe vai conferir; se precisar de algum dado específico, peça por texto.]`
    return caption ? `${caption}\n${corpo}` : corpo
  }

  // Tipo não legível automaticamente (ex.: .docx, .xlsx, vídeo, .zip).
  const nome = filename || 'arquivo'
  const corpo =
    `[O responsável enviou um documento: "${nome}"${mime ? ` (${mime})` : ''}. ` +
    `Provavelmente um comprovante/documento. Confirme o recebimento com gentileza e diga que a equipe vai conferir; ` +
    `se precisar de algum dado específico, peça por texto.]`
  return caption ? `${caption}\n${corpo}` : corpo
}

/**
 * (Evolution) Se a mensagem for áudio ou imagem, devolve um texto que a representa.
 * Retorna null quando não é mídia tratável (o fluxo de texto segue normalmente).
 */
export async function extrairConteudoMidia(data: EvolutionData): Promise<string | null> {
  const msg = data.message || {}
  const temAudio = !!msg.audioMessage
  const temImagem = !!msg.imageMessage
  const doc = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage
  const temDoc = !!doc
  if (!temAudio && !temImagem && !temDoc) return null

  const midia = await baixarMidiaBase64(data)
  if (!midia) {
    return temAudio
      ? '[O responsável enviou um áudio, mas não consegui baixá-lo. Peça, com gentileza, que ele repita por texto.]'
      : temImagem
        ? '[O responsável enviou uma imagem, mas não consegui abri-la. Peça, com gentileza, que ele reenvie ou descreva por texto.]'
        : '[O responsável enviou um documento, mas não consegui baixá-lo. Peça, com gentileza, que ele reenvie ou descreva por texto.]'
  }

  return interpretarMidia(
    temAudio ? 'audio' : temImagem ? 'imagem' : 'documento',
    midia.base64,
    midia.mimetype,
    msg.imageMessage?.caption || doc?.caption || undefined,
    doc?.fileName || doc?.title || undefined
  )
}

// ============================================================================
// WAHA — extração de mídia recebida.
// ============================================================================

// Mapeia mimetype para o tipo que interpretarMidia entende e para o tipo_midia do banco.
function classificarTipoMidia(mimetype: string): {
  tipoInterpretar: 'audio' | 'imagem' | 'documento'
  tipoDb: 'imagem' | 'audio' | 'documento' | 'video'
} {
  const m = (mimetype || '').toLowerCase()
  if (m.startsWith('audio/')) return { tipoInterpretar: 'audio', tipoDb: 'audio' }
  if (m.startsWith('image/')) return { tipoInterpretar: 'imagem', tipoDb: 'imagem' }
  if (m.startsWith('video/')) return { tipoInterpretar: 'documento', tipoDb: 'video' }
  return { tipoInterpretar: 'documento', tipoDb: 'documento' }
}

/**
 * (WAHA) Extrai a mídia do payload do evento: baixa de `payload.media.url` (com a
 * chave do WAHA), salva no bucket 'midias' e devolve o texto interpretado para a
 * Sara + o tipo/caminho para gravar no chat. Retorna null se não houver mídia.
 */
export async function extrairConteudoMidiaWaha(
  payload: any
): Promise<{ conteudo: string; tipoMidia: string; urlMidia: string | null } | null> {
  const media = payload?.media
  const mediaUrl: string | undefined = media?.url || payload?.mediaUrl
  if (!payload?.hasMedia && !mediaUrl) return null

  const caption: string | undefined = (payload?.body || '').trim() || undefined
  const filename: string | undefined = media?.filename || undefined
  let mimetype: string = (media?.mimetype || '').split(';')[0].trim()

  // hasMedia mas o WAHA não disponibilizou o arquivo (download desligado no server).
  if (!mediaUrl) {
    return {
      conteudo:
        '[O responsável enviou uma mídia, mas o WhatsApp não a disponibilizou por aqui. Agradeça e, se parecer importante, peça para reenviar como texto. NÃO presuma o assunto — em especial, NÃO trate como comprovante.]',
      tipoMidia: 'documento',
      urlMidia: null,
    }
  }

  // Baixa o binário do file-server do WAHA (usa a chave por segurança).
  let base64: string | null = null
  try {
    const { getWahaConfig } = await import('@/lib/waha')
    const { key } = await getWahaConfig()
    const r = await fetch(mediaUrl, { headers: key ? { 'X-Api-Key': key } : {} })
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer())
      base64 = buf.toString('base64')
      if (!mimetype) mimetype = (r.headers.get('content-type') || '').split(';')[0].trim()
    } else {
      console.error('[midia-waha] download falhou:', r.status)
    }
  } catch (e) {
    console.error('[midia-waha] erro no download:', e)
  }

  if (!base64) {
    return {
      conteudo:
        '[O responsável enviou uma mídia, mas não consegui baixá-la. Peça, com gentileza, que reenvie ou descreva por texto.]',
      tipoMidia: 'documento',
      urlMidia: null,
    }
  }

  const { tipoInterpretar, tipoDb } = classificarTipoMidia(mimetype)
  const { createServerAdminClient } = await import('@/lib/supabase-server')
  const supabase = createServerAdminClient()
  const urlMidia = await salvarMidiaStorage(supabase, { base64, mimetype, filename })
  const conteudo = await interpretarMidia(tipoInterpretar, base64, mimetype, caption, filename)
  return { conteudo, tipoMidia: tipoDb, urlMidia }
}
