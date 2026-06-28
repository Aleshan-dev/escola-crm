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
