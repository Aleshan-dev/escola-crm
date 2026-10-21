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
async function resolverConta(phoneId?: string | null): Promise<Conta | null> {
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

// Envio unificado: usa a conta Cloud ativa (banco) ou o env como fallback.
// Retorna o id da mensagem (wid) ou null. Ponto único de saída do WhatsApp.
// Canal do contato: 'waha' quando o lead conversa pelo número WAHA (não-oficial).
// Setado pelos webhooks de entrada (pelo canal onde o lead escreveu). Roteia a
// SAÍDA para o mesmo número — senão a resposta sai por um número diferente do
// que o lead usou. null/'cloud' = Cloud API (atendimento oficial).
async function contatoUsaWaha(to: string): Promise<boolean> {
  try {
    const { createServerAdminClient } = await import('@/lib/supabase-server')
    const supabase = createServerAdminClient()
    const { data } = await supabase
      .from('familias')
      .select('canal_whatsapp')
      .eq('telefone', to)
      .maybeSingle<{ canal_whatsapp: string | null }>()
    return data?.canal_whatsapp === 'waha'
  } catch {
    return false
  }
}

/**
 * Canal físico por onde `enviarTextoWhatsApp(to, …, phoneId)` vai sair — mesma
 * regra de roteamento dele. Usado pelo portão de envio (src/lib/envio) para
 * contar ritmo e teto no número certo.
 */
export async function canalDeSaida(to: string, phoneId?: string | null): Promise<'waha' | 'cloud' | 'evolution'> {
  if (await contatoUsaWaha(to)) return 'waha'
  const conta = await resolverConta(phoneId)
  if (conta?.phone_number_id && conta?.token) return 'cloud'
  const { canalNaoOficial } = await import('@/lib/evolution')
  return canalNaoOficial()
}

export async function enviarTextoWhatsApp(
  to: string,
  texto: string,
  phoneId?: string | null,
): Promise<string | null> {
  // Roteamento por canal: contato do WAHA responde PELO WAHA (mesmo número que
  // ele usou). WAHA não tem janela de 24h — envia direto.
  if (await contatoUsaWaha(to)) {
    const { wahaSendText } = await import('@/lib/waha')
    const sent = await wahaSendText(to, texto)
    return sent?.key?.id || null
  }

  // Canal Cloud oficial: SOMENTE quando há conta Cloud ATIVA no banco.
  // O fallback por env (WHATSAPP_PHONE_NUMBER_ID/TOKEN) foi removido de propósito:
  // um número Cloud encostado com token expirado no env reintroduzia o canal morto
  // e derrubava a saída com erro 100/33 da Meta ("Object ... does not exist"), em
  // vez de cair no Evolution. Sem conta ativa, a saída vai pelo Evolution (canal ativo).
  const conta = await resolverConta(phoneId)
  if (conta?.phone_number_id && conta?.token) {
    const sent = await enviarTextoCloudConta(conta.phone_number_id, conta.token, to, texto)
    return sent?.messages?.[0]?.id || null
  }

  // Sem conta Cloud ativa: o número está conectado via Evolution -> envia pelo Evolution.
  const { evolutionSendText } = await import('@/lib/evolution')
  const sent = await evolutionSendText(to, texto)
  return sent?.key?.id || null
}

// ============================================================================
// Envio de MÍDIA (documento/imagem) pela equipe, a partir do chat do CRM.
// Mesmo ponto único de saída do texto: usa a conta Cloud ativa (banco) se houver,
// senão cai no Evolution (celular via coexistência — o canal ativo hoje).
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

/**
 * Envia uma mídia (documento/imagem/...) para o contato. Devolve o wid e o
 * `tipo_midia` a gravar no histórico. Lança em erro (o chamador trata janela etc.).
 */
export async function enviarMidiaWhatsApp(
  to: string,
  midia: MidiaSaida,
  phoneId?: string | null,
): Promise<{ wid: string | null; tipo: 'imagem' | 'video' | 'audio' | 'documento' }> {
  const { kind, tipo } = classificarMidia(midia.mimetype)

  // Roteamento por canal: contato do WAHA recebe a mídia PELO WAHA (mesmo número).
  if (await contatoUsaWaha(to)) {
    if (!midia.url) throw new Error('Envio de mídia por WAHA requer URL da mídia')
    const { wahaSendMedia } = await import('@/lib/waha')
    const sent = await wahaSendMedia(to, {
      media: midia.url,
      fileName: midia.filename,
      caption: midia.caption,
      mediatype: kind,
      mimetype: midia.mimetype,
    })
    return { wid: sent?.key?.id || null, tipo }
  }

  // Canal Cloud oficial: SOMENTE quando há conta Cloud ATIVA no banco (mesma
  // regra do texto). Sem fallback de env — ver enviarTextoWhatsApp acima.
  const conta = await resolverConta(phoneId)
  if (conta?.phone_number_id && conta?.token) {
    const mediaId = await cloudUploadMedia(conta.phone_number_id, conta.token, midia.base64, midia.mimetype, midia.filename)
    const wid = await cloudSendMedia(conta.phone_number_id, conta.token, to, kind, mediaId, midia.filename, midia.caption)
    return { wid, tipo }
  }

  // Sem canal Cloud: envia pelo Evolution (baixa a partir da URL assinada).
  if (!midia.url) throw new Error('Envio por Evolution requer URL da mídia')
  const { evolutionSendMedia } = await import('@/lib/evolution')
  const sent = await evolutionSendMedia(to, {
    media: midia.url,
    fileName: midia.filename,
    caption: midia.caption,
    mediatype: kind,
    mimetype: midia.mimetype,
  })
  return { wid: sent?.key?.id || null, tipo }
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
  const conta = await resolverConta(phoneId)
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
