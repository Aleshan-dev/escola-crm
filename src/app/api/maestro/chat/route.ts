import { NextRequest, NextResponse } from 'next/server'
import { conversarComMaestro } from '@/lib/maestro/conversa'
import type { Mensagem } from '@/lib/ia-credenciais'

// Chat com o Mestre Guardião. Protegido por sessão pelo middleware (não é
// webhook/cron/admin). Recebe o histórico da conversa e devolve a fala do
// Maestro + propostas de mudança (que o gestor aplica no /api/maestro/aplicar).

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const historicoBruto = Array.isArray(body?.historico) ? body.historico : null
  if (!historicoBruto) return NextResponse.json({ error: 'Envie o histórico da conversa.' }, { status: 400 })

  const historico: Mensagem[] = historicoBruto
    .filter((m: unknown): m is { role: string; content: unknown } => !!m && typeof m === 'object' && 'role' in m)
    .map((m: { role: string; content: unknown }) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? ''),
    }))
    .filter((m: Mensagem) => m.content.trim().length > 0)

  if (historico.length === 0) return NextResponse.json({ error: 'Nenhuma mensagem válida.' }, { status: 400 })

  try {
    const resultado = await conversarComMaestro(historico)
    return NextResponse.json(resultado)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erro ao falar com o Maestro.'
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 })
  }
}
