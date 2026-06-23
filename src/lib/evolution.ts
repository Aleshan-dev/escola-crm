const URL = process.env.EVOLUTION_API_URL!
const KEY = process.env.EVOLUTION_API_KEY!
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME!

export async function evolutionSendText(numero: string, texto: string) {
  const r = await fetch(`${URL}/message/sendText/${INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({
      number: numero,
      text: texto,
    }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Evolution send falhou (${r.status}): ${t}`)
  }
  return r.json()
}

// Limpa número do formato WhatsApp ('5589xxxx@s.whatsapp.net' → '5589xxxx')
export function cleanWhatsappJid(jid: string): string {
  return jid.split('@')[0].split(':')[0]
}
