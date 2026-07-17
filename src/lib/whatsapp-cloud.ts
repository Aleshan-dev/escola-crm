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
export async function enviarTextoWhatsApp(
  to: string,
  texto: string,
  phoneId?: string | null,
): Promise<string | null> {
  const conta = await resolverConta(phoneId)

  if (conta?.token) {
    const sent = await enviarTextoCloudConta(conta.phone_number_id, conta.token, to, texto)
    return sent?.messages?.[0]?.id || null
  }

  // Sem conta Cloud ativa: o número está conectado via Evolution -> envia pelo Evolution.
  const { evolutionSendText } = await import('@/lib/evolution')
  const sent = await evolutionSendText(to, texto)
  return sent?.key?.id || null
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
