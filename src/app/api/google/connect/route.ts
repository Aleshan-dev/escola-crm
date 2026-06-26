import { NextResponse } from 'next/server'

const REDIRECT = 'https://escola-crm.vercel.app/api/google/callback'

export async function GET() {
  const params = new URLSearchParams({
    client_id: '399470356836-r0kgrpnv5vutp8fsq263sa4kcafv9b4m.apps.googleusercontent.com',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
  })
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
}
