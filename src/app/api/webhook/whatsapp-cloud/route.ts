import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { gerarRespostaSara, SaraColuna } from '@/lib/sara'
import { enviarTextoCloud, enviarTextoCloudConta } from '@/lib/whatsapp-cloud'

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const vt = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim()
  if (p.get('hub.mode') === 'subscribe' && vt !== '' && (p.get('hub.verify_token') || '').trim() === vt) {
    return new NextResponse(p.get('hub.challenge') || '', { status: 200 })
  }
  return new NextResponse('forbidden', { status: 403 })
}

export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()
  try {
    const body = await req.json()
    const value = body?.entry?.[0]?.changes?.[0]?.value
    const phoneNumberId: string = value?.metadata?.phone_number_id || ''
    const { data: conta } = await supabase
      .from('whatsapp_contas')
      .select('phone_number_id, token')
      .eq('phone_number_id', phoneNumberId)
      .eq('ativo', true)
      .maybeSingle()
    const msg = value?.messages?.[0]
    if (!msg || msg.type !== 'text') return NextResponse.json({ ignored: true })

    const telefone: string = msg.from
    const conteudo: string = msg.text?.body || ''
    const pushName: string = value?.contacts?.[0]?.profile?.name || 'Família'
    const wid: string = msg.id || ''

    let { data: familia } = await supabase.from('familias').select('id, nome_responsavel').eq('telefone', telefone).maybeSingle()
    if (!familia) {
      const ins = await supabase.from('familias').insert({ nome_responsavel: pushName, telefone, origem: 'whatsapp-oficial' }).select('id, nome_responsavel').single()
      familia = ins.data
    }
    if (!familia) throw new Error('Falha ao criar família')
    const familiaNome: string = familia.nome_responsavel

    let { data: lead } = await supabase.from('leads').select('id, ia_ativa, coluna_id, sara_pode_mover').eq('familia_id', familia.id).order('criado_em', { ascending: false }).limit(1).maybeSingle()
    if (!lead) {
      const { data: primeiraColuna } = await supabase.from('colunas').select('id, ia_ativa_default').order('ordem').limit(1).single()
      const ins = await supabase.from('leads').insert({ familia_id: familia.id, coluna_id: primeiraColuna!.id, ia_ativa: primeiraColuna!.ia_ativa_default, tags: ['whatsapp-oficial'] }).select('id, ia_ativa, coluna_id, sara_pode_mover').single()
      lead = ins.data
    }
    if (!lead) throw new Error('Falha ao criar lead')

    const leadId: string = lead.id
    const leadColunaId: string = lead.coluna_id
    const podeMover: boolean = lead.sara_pode_mover !== false
    const iaAtiva: boolean = lead.ia_ativa

    await supabase.from('mensagens').insert({ lead_id: leadId, direcao: 'in', conteudo, whatsapp_message_id: wid })
    await supabase.from('leads').update({ ultima_interacao_em: new Date().toISOString() }).eq('id', leadId)

    if (iaAtiva) {
      const { data: todasColunas } = await supabase.from('colunas').select('id, nome, ordem').order('ordem')
      const cols = (todasColunas as unknown as SaraColuna[]) || []
      const colunaAtual = cols.find((c) => c.id === leadColunaId)
      const saraResult = await gerarRespostaSara(leadId, cols, colunaAtual)

      const baloes = saraResult.resposta.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).slice(0, 3)
      const partes = baloes.length > 0 ? baloes : [saraResult.resposta.trim()]
      for (let i = 0; i < partes.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1200))
        let sent: { messages?: { id?: string }[] } | null = null
        let statusEnvio = 'enviado'
        let erroEnvio: string | null = null
        try {
          sent = conta?.token
            ? await enviarTextoCloudConta(conta.phone_number_id, conta.token, telefone, partes[i])
            : await enviarTextoCloud(telefone, partes[i])
        } catch (err) {
          statusEnvio = 'falha'
          erroEnvio = err instanceof Error ? err.message : String(err)
          console.error(`[whatsapp-cloud] envio falhou lead=${leadId} tel=${telefone}: ${erroEnvio}`)
        }
        await supabase.from('mensagens').insert({ lead_id: leadId, direcao: 'out_ia', conteudo: partes[i], whatsapp_message_id: sent?.messages?.[0]?.id || null, status: statusEnvio, erro_envio: erroEnvio })
      }

      if (saraResult.resumo_anotacao && saraResult.resumo_anotacao.trim()) {
        await supabase.from('anotacoes').insert({ lead_id: leadId, conteudo: saraResult.resumo_anotacao.trim() })
      }
      if (saraResult.agendar_visita_em) {
        const dataVisita = new Date(saraResult.agendar_visita_em)
        if (!isNaN(dataVisita.getTime())) {
          await supabase.from('tarefas').insert({ lead_id: leadId, titulo: `Visita — ${familiaNome}`, tipo: 'visita', data_hora: dataVisita.toISOString() })
        }
      }
      if (saraResult.proxima_coluna_id && podeMover && cols.some((c) => c.id === saraResult.proxima_coluna_id)) {
        await supabase.from('leads').update({ coluna_id: saraResult.proxima_coluna_id, entrou_coluna_em: new Date().toISOString() }).eq('id', leadId)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('whatsapp-cloud webhook erro:', e)
    return NextResponse.json({ ok: false })
  }
}
