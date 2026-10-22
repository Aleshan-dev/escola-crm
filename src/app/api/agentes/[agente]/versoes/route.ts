import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { ehAgente } from '@/lib/agente-versoes/regras'
import {
  carregarEstado, descartarRascunho, publicarRascunho, restaurarVersao, salvarRascunho,
} from '@/lib/agente-versoes/servico'

// Versionamento da configuração da Sara/Salomão (padrão DeskcommCRM).
// GET  → rascunho, publicada, histórico e o que está no ar.
// POST → { acao: 'salvar', snapshot } | { acao: 'publicar', nota? } | { acao: 'descartar' }
//        | { acao: 'restaurar', versao_id }
// Só 'publicar' e 'restaurar' mexem em produção (config_ia).

export const dynamic = 'force-dynamic'

async function usuario() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  return user
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ agente: string }> }) {
  const { agente } = await params
  if (!ehAgente(agente)) return NextResponse.json({ error: 'Agente inválido' }, { status: 404 })
  if (!(await usuario())) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  try {
    return NextResponse.json(await carregarEstado(agente))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erro' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agente: string }> }) {
  const { agente } = await params
  if (!ehAgente(agente)) return NextResponse.json({ error: 'Agente inválido' }, { status: 404 })
  const user = await usuario()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  const por = user.email ?? user.id

  const b = await req.json().catch(() => null)
  try {
    switch (b?.acao) {
      case 'salvar':
        await salvarRascunho(agente, b.snapshot, { origem: 'tela', por })
        break
      case 'publicar':
        await publicarRascunho(agente, { por, nota: typeof b.nota === 'string' ? b.nota : null })
        break
      case 'descartar':
        await descartarRascunho(agente)
        break
      case 'restaurar':
        if (typeof b.versao_id !== 'string') return NextResponse.json({ error: 'versao_id obrigatório' }, { status: 400 })
        await restaurarVersao(agente, b.versao_id, { por })
        break
      default:
        return NextResponse.json({ error: 'Ação inválida' }, { status: 400 })
    }
    return NextResponse.json(await carregarEstado(agente))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erro' }, { status: 400 })
  }
}
