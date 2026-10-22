async function postMessage(phoneId: string, token: string, to: string, texto: string) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: texto } }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Cloud send falhou (${r.status}): ${t}`)
  }
  return r.json()
}

// Envio pelo número fixo do env (compatibilidade / fallback)
export async function enviarTextoCloud(to: string, texto: string) {
  const token = process.env.WHATSAPP_CLOUD_TOKEN
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneId) throw new Error('WhatsApp Cloud API não configurada')
  return postMessage(phoneId, token, to, texto)
}

// Envio por conta específica (multi-tenant): credenciais vêm do banco
export async function enviarTextoCloudConta(phoneId: string, token: string, to: string, texto: string) {
  return postMessage(phoneId, token, to, texto)
}

// Baixa mídia da Cloud API (2 passos: metadata -> URL binária). Retorna base64 + mimetype.
export async function baixarMidiaCloud(
  mediaId: string,
  token: string
): Promise<{ base64: string; mimetype: string } | null> {
  try {
    const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!meta.ok) {
      console.error('[cloud-midia] metadata falhou:', meta.status, await meta.text())
      return null
    }
    const metaJson = await meta.json()
    const url: string | undefined = metaJson?.url
    const mimetype: string = metaJson?.mime_type || ''
    if (!url) return null
    const bin = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!bin.ok) {
      console.error('[cloud-midia] download falhou:', bin.status)
      return null
    }
    const buf = Buffer.from(await bin.arrayBuffer())
    return { base64: buf.toString('base64'), mimetype }
  } catch (e) {
    console.error('[cloud-midia] erro:', e)
    return null
  }
}

type Conta = { phone_number_id: string; token: string }

// Resolve a conta Cloud a usar: a do número pelo qual o lead chegou (multi-número)
// ou a conta ativa mais recente.
export async function resolverContaCloud(phoneId?: string | null): Promise<Conta | null> {
  const { createServerAdminClient } = await import('@/lib/supabase-server')
  const supabase = createServerAdminClient()

  if (phoneId) {
    const { data } = await supabase
      .from('whatsapp_contas')
      .select('phone_number_id, token')
      .eq('phone_number_id', phoneId)
      .eq('ativo', true)
      .maybeSingle<Conta>()
    if (data) return data
  }
  const { data } = await supabase
    .from('whatsapp_contas')
    .select('phone_number_id, token')
    .eq('ativo', true)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle<Conta>()
  return data
}

// A escolha do canal de saída (WAHA, Cloud, Evolution) mora em src/lib/canais:
// política por operação, sem fallback entre números. Aqui ficam só os
// transportes da Cloud.

/**
 * Canal da conversa com este contato — o mesmo que `enviarPeloCanal` usaria.
 * Para o portão de envio (src/lib/envio) contar ritmo e teto no número certo.
 */
export async function canalDeSaida(to: string, phoneId?: string | null): Promise<'waha' | 'cloud' | 'evolution'> {
  const { resolverCanal } = await import('@/lib/canais/enviar')
  return (await resolverCanal({ operacao: 'resposta', telefone: to, phoneId })).canal
}

// ============================================================================
// Envio de MÍDIA (documento/imagem) pela equipe, a partir do chat do CRM.
// Mesmo roteamento do texto: sai pelo canal da conversa (src/lib/canais).
// ============================================================================

export type MidiaSaida = {
  base64: string        // conteúdo do arquivo (para o upload da Cloud API)
  mimetype: string      // ex.: application/pdf, image/jpeg
  filename: string      // nome do arquivo (aparece no WhatsApp para documentos)
  caption?: string      // legenda opcional
  url?: string          // URL (assinada) do arquivo — usada pelo Evolution, que baixa e envia
}

// tipo p/ o WhatsApp (image/video/audio/document) + tipo_midia p/ o banco (imagem/...).
export function classificarMidia(mimetype: string): {
  kind: 'image' | 'video' | 'audio' | 'document'
  tipo: 'imagem' | 'video' | 'audio' | 'documento'
} {
  const m = (mimetype || '').toLowerCase()
  if (m.startsWith('image/')) return { kind: 'image', tipo: 'imagem' }
  if (m.startsWith('video/')) return { kind: 'video', tipo: 'video' }
  if (m.startsWith('audio/')) return { kind: 'audio', tipo: 'audio' }
  return { kind: 'document', tipo: 'documento' }
}

// Cloud API: sobe o binário para a Meta e devolve o media id (2 passos: upload → send).
async function cloudUploadMedia(
  phoneId: string, token: string, base64: string, mimetype: string, filename: string,
): Promise<string> {
  const buf = Buffer.from(base64, 'base64')
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('file', new Blob([buf], { type: mimetype || 'application/octet-stream' }), filename)
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  if (!r.ok) throw new Error(`Cloud upload mídia falhou (${r.status}): ${await r.text()}`)
  const j = await r.json()
  if (!j?.id) throw new Error('Cloud upload mídia: resposta sem id')
  return j.id
}

async function cloudSendMedia(
  phoneId: string, token: string, to: string,
  kind: 'image' | 'video' | 'audio' | 'document', mediaId: string,
  filename: string, caption?: string,
): Promise<string | null> {
  const media: Record<string, string> = { id: mediaId }
  if (kind === 'document') media.filename = filename
  if (caption && kind !== 'audio') media.caption = caption
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: kind, [kind]: media }),
  })
  if (!r.ok) throw new Error(`Cloud send mídia falhou (${r.status}): ${await r.text()}`)
  const j = await r.json()
  return j?.messages?.[0]?.id || null
}

/** Mídia por uma conta Cloud específica (upload → envio). Devolve o wid. */
export async function enviarMidiaCloudConta(
  phoneId: string, token: string, to: string, midia: MidiaSaida,
): Promise<string | null> {
  const { kind } = classificarMidia(midia.mimetype)
  const mediaId = await cloudUploadMedia(phoneId, token, midia.base64, midia.mimetype, midia.filename)
  return cloudSendMedia(phoneId, token, to, kind, mediaId, midia.filename, midia.caption)
}

// Texto renderizado dos templates aprovados — para gravar no histórico do CRM o que a
// família REALMENTE recebeu (em vez de "[template: x]"). DEVE espelhar o corpo aprovado
// na Meta (ver /api/admin/criar-template). Se o texto lá mudar, atualize aqui também.
export function corpoTemplate(name: string, variaveis: string[]): string {
  const nome = variaveis[0] || 'família'
  switch (name) {
    case 'retomada_lead':
      return `Olá, ${nome}! 😊 Aqui é a Sara, do Colégio Pequenos Guardiões. Passando para saber se você ainda gostaria de conhecer nossa escola e agendar uma visita. Estou por aqui para ajudar com qualquer dúvida!`
    case 'retorno_visita':
      return `Olá, ${nome}! Aqui é a Sara, do Colégio Pequenos Guardiões. Foi uma alegria receber vocês na visita. 💙 Como foi a experiência? Ficou alguma dúvida em que eu possa ajudar?`
    default:
      return `[template: ${name}]`
  }
}

// Envia um template APROVADO (funciona a qualquer hora, sem depender da janela de 24h).
// `variaveis` preenche os {{1}}, {{2}}... do corpo, na ordem. Só via Cloud API.
export async function enviarTemplateWhatsApp(
  to: string,
  templateName: string,
  language: string,
  variaveis: string[],
  phoneId?: string | null,
): Promise<string | null> {
  const conta = await resolverContaCloud(phoneId)
  if (!conta?.token) throw new Error('Sem conta Cloud ativa para enviar template')

  const components = variaveis.length
    ? [{ type: 'body', parameters: variaveis.map((v) => ({ type: 'text', text: v || '—' })) }]
    : []

  const r = await fetch(`https://graph.facebook.com/v21.0/${conta.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conta.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: language }, components },
    }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Cloud template falhou (${r.status}): ${t}`)
  }
  const j = await r.json()
  return j?.messages?.[0]?.id || null
}
