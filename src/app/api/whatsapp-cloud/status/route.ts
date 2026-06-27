import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    configurado: !!(process.env.WHATSAPP_CLOUD_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
    verifyConfigurado: !!process.env.WHATSAPP_VERIFY_TOKEN,
  })
}
