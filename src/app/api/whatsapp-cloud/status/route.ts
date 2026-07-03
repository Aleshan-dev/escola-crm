import { NextResponse } from 'next/server'

export async function GET() {
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://escola-crm.vercel.app'
  return NextResponse.json({
    // Necessário para o Embedded Signup (trocar o code por token)
    metaAppSecret: !!process.env.META_APP_SECRET,
    // Necessário para a verificação do webhook no app da Meta
    verifyToken: !!process.env.WHATSAPP_VERIFY_TOKEN,
    // Fallback por número fixo em env (opcional; a conexão salva o token por conta)
    fallbackConfigurado: !!(process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
    // URL que deve ser cadastrada como Callback no webhook do app da Meta
    webhookUrl: `${base}/api/webhook/whatsapp-cloud`,
  })
}
