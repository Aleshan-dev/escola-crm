import { NextRequest, NextResponse } from 'next/server'
import { aplicarAcao } from '@/lib/maestro/conversa'

// Aplica UMA proposta do Maestro — só no clique do gestor. Protegido por sessão
// pelo middleware. A ação é revalidada contra a allowlist dentro de aplicarAcao;
// o que o modelo "disse" que a ação faz não é confiável aqui.

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.acao) return NextResponse.json({ ok: false, mensagem: 'Nenhuma ação enviada.' }, { status: 400 })

  const resultado = await aplicarAcao(body.acao)
  return NextResponse.json(resultado, { status: resultado.ok ? 200 : 400 })
}
