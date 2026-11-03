import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { acionarIAParaLead } from '@/lib/acionar-ia'

// Faz a IA responder AGORA a última mensagem do lead (continuar de onde parou),
// acionado manualmente pelo atendente na tela do lead. A lógica (roteamento Sara/
// Salomão, envio em balões, janela de 24h, trava de resposta) mora em
// src/lib/acionar-ia.ts e é compartilhada com a rede de segurança (src/lib/resgate.ts).
//
// 30s não bastava: gerarRespostaSara (modelo) + envio dos balões com pausas estourava
// o teto e a função morria com "Task timed out", mostrando "falha ao acionar a Sara"
// mesmo tendo enviado o 1º balão. 120s dá folga para o turno mais pesado (ofertar visita).
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id } = await req.json()
  if (!lead_id) return NextResponse.json({ error: 'lead_id obrigatório' }, { status: 400 })

  const r = await acionarIAParaLead(lead_id)
  // Janela fechada não é erro de servidor (a UI mostra o aviso); demais falhas → 500.
  if (!r.ok && !r.janela_fechada && r.error) {
    return NextResponse.json({ error: r.error }, { status: 500 })
  }
  return NextResponse.json(r)
}
