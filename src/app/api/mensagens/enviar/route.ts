import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { enviarTextoComFallback } from '@/lib/janela'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id, texto } = await req.json()
  if (!lead_id || !texto) return NextResponse.json({ error: 'lead_id e texto obrigatórios' }, { status: 400 })

  // Pega telefone do lead
  const { data: lead } = await supabase
    .from('leads')
    .select('familia:familias(telefone, whatsapp_phone_number_id)')
    .eq('id', lead_id)
    .single<{ familia: { telefone: string; whatsapp_phone_number_id: string | null } }>()

  if (!lead?.familia?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })

  try {
    const r = await enviarTextoComFallback(lead.familia.telefone, texto, {
      leadId: lead_id,
      phoneId: lead.familia.whatsapp_phone_number_id,
    })

    // Fora da janela de 24h: NÃO foi enviado. Já criamos um alerta (tela Alertas)
    // para envio manual pelo celular. Não gravamos como out_humano — quando a
    // secretária enviar do celular, o echo (smb_message_echoes) registra no chat.
    if (!r.enviado && r.janelaFechada) {
      return NextResponse.json({
        ok: false,
        janela_fechada: true,
        aviso: r.alertaCriado
          ? 'Fora da janela de 24h. Criei um alerta em "Alertas" para envio manual pelo celular.'
          : 'Fora da janela de 24h. Lead inativo (perdido/arquivado) — nenhum alerta criado.',
      })
    }

    // Enviado dentro da janela: grava no histórico.
    // NÃO gravamos enviado_por com o id de auth: a FK aponta para `usuarios`
    // (hoje vazia), então preencher violaria a constraint. A coluna aceita nulo.
    const { error: errMsg } = await supabase.from('mensagens').insert({
      lead_id,
      direcao: 'out_humano',
      conteudo: texto,
      whatsapp_message_id: r.wid,
    })
    if (errMsg) {
      // 23505 = unique_violation em whatsapp_message_id: o ECHO desta mesma
      // mensagem (message.any/smb_echo do WhatsApp) chegou primeiro e já gravou.
      // A mensagem foi enviada E está no histórico — sucesso, não erro.
      if (errMsg.code === '23505') {
        return NextResponse.json({ ok: true, jaGravadaPeloEcho: true })
      }
      return NextResponse.json({ error: `Mensagem enviada, mas falhou ao gravar no histórico: ${errMsg.message}` }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
