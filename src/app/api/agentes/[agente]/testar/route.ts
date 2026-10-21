import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { ehAgente, normalizarSnapshot } from '@/lib/agente-versoes/regras'
import { carregarEstado } from '@/lib/agente-versoes/servico'
import { gerarRespostaSara } from '@/lib/sara'
import { gerarRespostaSalomaoLLM } from '@/lib/salomao'

// "Testar rascunho": gera a resposta que o agente daria AGORA para a conversa de
// um lead real, usando a configuração do rascunho (ou a do ar, para comparar).
// Não envia nada, não grava mensagem, não move lead. CHAMA A IA (tem custo).
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ agente: string }> }) {
  const { agente } = await params
  if (!ehAgente(agente)) return NextResponse.json({ error: 'Agente inválido' }, { status: 404 })
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const b = await req.json().catch(() => null)
  const leadId = String(b?.lead_id ?? '').trim()
  if (!leadId) return NextResponse.json({ error: 'Escolha um lead' }, { status: 400 })

  const db = createServerAdminClient()
  const estado = await carregarEstado(agente, db)
  // Usa o snapshot enviado pela tela (edição ainda não salva) ou o rascunho salvo.
  const override = b?.snapshot ? normalizarSnapshot(agente, b.snapshot) : estado.editor

  try {
    if (agente === 'sara') {
      const r = await gerarRespostaSara(leadId, undefined, undefined, undefined, override)
      return NextResponse.json({ resposta: r.resposta, transbordo: r.transbordo, analise: r.analise })
    }
    const r = await gerarRespostaSalomaoLLM(db, leadId, undefined, 0, override)
    return NextResponse.json({ resposta: r.resposta, transbordo: r.transbordo, acao: r.acao })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erro ao testar' }, { status: 500 })
  }
}
