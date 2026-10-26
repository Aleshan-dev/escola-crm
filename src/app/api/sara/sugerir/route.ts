import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { gerarRespostaSara } from '@/lib/sara'

// Gera a resposta da Sara SEM enviar — para pré-preencher a caixa de resposta
// manual do atendente ("a mensagem da Sara já vem pronta"). Não grava mensagem
// nem pausa a IA; é só uma sugestão.
//
// `instrucao` (opcional): comando do atendente que a Sara deve seguir ao redigir
// (ex.: "ofereça terça 15h", "responda a objeção de preço ancorando no valor base").
// Vazio = a Sara continua a conversa apenas pelo contexto. Vira o promptAdicional
// ("INSTRUÇÃO ESPECIAL") do gerador.
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id, instrucao } = await req.json()
  if (!lead_id) return NextResponse.json({ error: 'lead_id obrigatório' }, { status: 400 })

  const comando = typeof instrucao === 'string' && instrucao.trim() ? instrucao.trim() : undefined

  try {
    const sara = await gerarRespostaSara(lead_id, undefined, undefined, comando)
    if (!sara.resposta?.trim()) return NextResponse.json({ error: 'Sara não gerou resposta' }, { status: 500 })
    return NextResponse.json({ ok: true, resposta: sara.resposta })
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Erro desconhecido' }, { status: 500 })
  }
}
