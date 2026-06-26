import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { cleanWhatsappJid, evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara, SaraColuna } from '@/lib/sara'

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook escola-crm online' })
}

export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()

  try {
    const body = await req.json()
    const event = body.event
    const data = body.data

    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return NextResponse.json({ ignored: event })
    }

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

    // 2. Garante lead
    let { data: lead } = await supabase
      .from('leads')
      .select('id, ia_ativa, coluna_id, sara_pode_mover')
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
        .select('id, ia_ativa, coluna_id, sara_pode_mover')
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

    // Atualiza ultima_interacao_em
    await supabase
      .from('leads')
      .update({ ultima_interacao_em: new Date().toISOString() })
      .eq('id', lead.id)

    // 4. Sara IA
    if (lead.ia_ativa) {
      try {
        const { data: todasColunas } = await supabase
          .from('colunas')
          .select('id, nome, ordem')
          .order('ordem')

        const colunaAtual = todasColunas?.find((c) => c.id === lead.coluna_id) as
          | SaraColuna
          | undefined

        const saraResult = await gerarRespostaSara(
          lead.id,
          todasColunas as SaraColuna[] | undefined,
          colunaAtual
        )

        // Divide a resposta da Sara em baloes (paragrafos separados por linha em branco)
        const baloes = saraResult.resposta
          .split(/\n\s*\n/)
          .map((b) => b.trim())
          .filter(Boolean)
          .slice(0, 3)
        const partes = baloes.length > 0 ? baloes : [saraResult.resposta.trim()]

        for (let i = 0; i < partes.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 1200))
          const sent = await evolutionSendText(telefone, partes[i])
          await supabase.from('mensagens').insert({
            lead_id: lead.id,
            direcao: 'out_ia',
            conteudo: partes[i],
            whatsapp_message_id: sent?.key?.id || null,
          })
        }

        // Anotacao automatica: registra um resumo da conversa quando ha fato novo
        if (saraResult.resumo_anotacao && saraResult.resumo_anotacao.trim()) {
          await supabase.from('anotacoes').insert({
            lead_id: lead.id,
            conteudo: saraResult.resumo_anotacao.trim(),
          })
        }

        // Agendamento automatico: cria a visita quando a Sara confirma data e hora
        if (saraResult.agendar_visita_em) {
          const dataVisita = new Date(saraResult.agendar_visita_em)
          if (!isNaN(dataVisita.getTime())) {
            await supabase.from('tarefas').insert({
              lead_id: lead.id,
              titulo: `Visita — ${familia.nome_responsavel}`,
              tipo: 'visita',
              data_hora: dataVisita.toISOString(),
            })
          }
        }

        // 5. Guard-rails de movimentação
        if (saraResult.proxima_coluna_id && lead.sara_pode_mover !== false && todasColunas && colunaAtual) {
          const proximaColuna = todasColunas.find((c) => c.id === saraResult.proxima_coluna_id)

          let motivoRecusa: string | null = null

          if (!proximaColuna) {
            motivoRecusa = 'coluna_inexistente'
          } else if (proximaColuna.ordem > colunaAtual.ordem + 1) {
            motivoRecusa = `pulou_etapas: tentou ir para ordem ${proximaColuna.ordem} da ordem ${colunaAtual.ordem}`
          } else if (proximaColuna.ordem <= colunaAtual.ordem) {
            motivoRecusa = `regressao: ordem ${proximaColuna.ordem} <= atual ${colunaAtual.ordem}`
          } else if (proximaColuna.nome === 'Matriculados') {
            motivoRecusa = 'matriculados_requer_confirmacao_humana'
          } else if (proximaColuna.nome === 'Perdidos' && !saraResult.razao_movimentacao) {
            motivoRecusa = 'perdidos_sem_razao'
          }

          if (motivoRecusa) {
            await supabase.from('acoes_sara').insert({
              lead_id: lead.id,
              tipo: 'movimentacao',
              conteudo: `Tentativa de mover para "${proximaColuna?.nome}" recusada`,
              razao: motivoRecusa,
              sucesso: false,
              coluna_origem_id: colunaAtual.id,
              coluna_destino_id: saraResult.proxima_coluna_id,
            })
          } else {
            await supabase
              .from('leads')
              .update({
                coluna_id: saraResult.proxima_coluna_id,
                entrou_coluna_em: new Date().toISOString(),
              })
              .eq('id', lead.id)

            await supabase.from('acoes_sara').insert({
              lead_id: lead.id,
              tipo: 'movimentacao',
              conteudo: saraResult.razao_movimentacao || `Movido para ${proximaColuna!.nome}`,
              razao: saraResult.razao_movimentacao,
              sucesso: true,
              coluna_origem_id: colunaAtual.id,
              coluna_destino_id: saraResult.proxima_coluna_id,
            })
          }
        }
      } catch (e) {
        console.error('Sara IA falhou:', e)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('Webhook error:', e)
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
