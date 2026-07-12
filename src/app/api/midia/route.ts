import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Serve um arquivo do bucket privado 'midias' sob autenticação de sessão.
// Gera uma URL assinada de curta duração e redireciona — assim <img>, <audio>
// e <a> funcionam direto, e o arquivo nunca fica público.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const path = req.nextUrl.searchParams.get('path')
  if (!path) return NextResponse.json({ error: 'path obrigatório' }, { status: 400 })

  const admin = createServerAdminClient()
  const { data, error } = await admin.storage.from('midias').createSignedUrl(path, 300)
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: 'arquivo não encontrado' }, { status: 404 })
  }
  return NextResponse.redirect(data.signedUrl)
}
