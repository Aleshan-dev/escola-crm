import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { cleanWhatsappJid, evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara } from '@/lib/sara'

// GET para verificar que o webhook está vivo
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook escola-crm online' })
}

// POST recebe eventos da Evolution
export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()

  try {
    const body = await req.json()

    // Estrutura do evento Evolution: { event, instance, data }
    const event = body.event
    const data = body.data

    // Só processamos mensagens recebidas
    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return NextResponse.json({ ignored: event })
    }

    // Ignora mensagens enviadas pela própria escola (fromMe)
    if (data?.key?.fromMe === true) return NextResponse.json({ ignored: 'fromMe' })

    const jid: string = data?.key?.remoteJid || ''
    if (!jid || jid.includes('@g.us')) return NextResponse.json({ ignored: 'group ou sem jid' })

    const telefone = cleanWhatsappJid(jid)
    const conteudo: string =
      data?.message?.conversation ||
      data?.message?.extendedTextMessage?.text ||
      data?.message?.imageMessage?.caption ||
      '[mídia ou tipo não suportado ainda]'

    const pushName: string = data?.pushName || 'Família'
    const wid: string = data?.key?.id || ''

    // 1. Garante família
    let { data: familia } = await supabase
      .from('familias')
      .select('id, nome_responsavel')
      .eq('telefone', telefone)
      .maybeSingle()

    if (!familia) {
      const ins = await supabase
        .from('familias')
        .insert({ nome_responsavel: pushName, telefone, origem: 'whatsapp' })
        .select('id, nome_responsavel')
        .single()
      familia = ins.data
    }
    if (!familia) throw new Error('Falha ao criar família')

    // 2. Garante lead na primeira coluna ('Capturados')
    let { data: lead } = await supabase
      .from('leads')
      .select('id, ia_ativa, coluna_id')
      .eq('familia_id', familia.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!lead) {
      const { data: primeiraColuna } = await supabase
        .from('colunas')
        .select('id, ia_ativa_default')
        .order('ordem')
        .limit(1)
        .single()

      const ins = await supabase
        .from('leads')
        .insert({
          familia_id: familia.id,
          coluna_id: primeiraColuna!.id,
          ia_ativa: primeiraColuna!.ia_ativa_default,
          tags: ['whatsapp'],
        })
        .select('id, ia_ativa, coluna_id')
        .single()
      lead = ins.data
    }
    if (!lead) throw new Error('Falha ao criar lead')

    // 3. Salva mensagem recebida
    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'in',
      conteudo,
      whatsapp_message_id: wid,
    })

    // 4. Se IA ativa, gera resposta e envia
    if (lead.ia_ativa) {
      try {
        const resposta = await gerarRespostaSara(lead.id)
        const sent = await evolutionSendText(telefone, resposta)

        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          conteudo: resposta,
          whatsapp_message_id: sent?.key?.id || null,
        })
      } catch (e) {
        console.error('Sara IA falhou:', e)
        // Não derruba o webhook por causa da IA
      }
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('Webhook error:', e)
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
