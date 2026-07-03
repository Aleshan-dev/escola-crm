/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI, { toFile } from 'openai'

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
    const r = await fetch(`${URL}/chat/getBase64FromMediaMessage/${INSTANCE}`, {
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

async function transcreverAudio(base64: string, mimetype: string): Promise<string | null> {
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
    console.error('[midia] transcrição falhou:', e)
    return null
  }
}

async function descreverImagem(base64: string, mimetype: string): Promise<string | null> {
  try {
    const dataUrl = `data:${mimetype || 'image/jpeg'};base64,${base64}`
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content:
            'Você descreve imagens enviadas por responsáveis no WhatsApp de uma escola de educação infantil. Em 1-2 frases, em português, diga objetivamente o que a imagem mostra (ex.: documento como RG, CPF, comprovante de residência ou de pagamento; print de conversa; foto da criança). Se houver texto legível relevante, resuma-o. Nunca invente informações.',
        },
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
    console.error('[midia] descrição de imagem falhou:', e)
    return null
  }
}

/**
 * Se a mensagem for áudio ou imagem, devolve um texto que a representa para a Sara.
 * Retorna null quando não é mídia tratável (o fluxo de texto segue normalmente).
 */
export async function extrairConteudoMidia(data: EvolutionData): Promise<string | null> {
  const msg = data.message || {}
  const temAudio = !!msg.audioMessage
  const temImagem = !!msg.imageMessage
  if (!temAudio && !temImagem) return null

  const midia = await baixarMidiaBase64(data)
  if (!midia) {
    return temAudio
      ? '[O responsável enviou um áudio, mas não consegui baixá-lo. Peça, com gentileza, que ele repita por texto.]'
      : '[O responsável enviou uma imagem, mas não consegui abri-la. Peça, com gentileza, que ele reenvie ou descreva por texto.]'
  }

  if (temAudio) {
    const texto = await transcreverAudio(midia.base64, midia.mimetype)
    return texto || '[O responsável enviou um áudio que não consegui transcrever. Peça, com gentileza, que repita por texto.]'
  }

  const caption: string = msg.imageMessage?.caption || ''
  const desc = await descreverImagem(midia.base64, midia.mimetype)
  const corpo = desc
    ? `[O responsável enviou uma imagem. Conteúdo: ${desc}]`
    : '[O responsável enviou uma imagem que não consegui interpretar.]'
  return caption ? `${caption}\n${corpo}` : corpo
}
