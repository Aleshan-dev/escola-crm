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

    let { data: lead } = await supabase
      .from('leads')
      .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano')
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
        .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano')
        .single()
      lead = ins.data
    }
    if (!lead) throw new Error('Falha ao criar lead')

    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'in',
      conteudo,
      whatsapp_message_id: wid,
    })

    await supabase
      .from('leads')
      .update({ ultima_interacao_em: new Date().toISOString() })
      .eq('id', lead.id)

    if (lead.ia_ativa && !lead.precisa_atendimento_humano) {
      try {
        const { data: todasColunas } = await supabase
          .from('colunas')
          .select('id, nome, ordem')
          .order('ordem')

        const colunaAtual = todasColunas?.find((c) => c.id === lead.coluna_id) as SaraColuna | undefined

        const saraResult = await gerarRespostaSara(lead.id, todasColunas as SaraColuna[] | undefined, colunaAtual)

        const sent = await evolutionSendText(telefone, saraResult.resposta)

        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          conteudo: saraResult.resposta,
          whatsapp_message_id: sent?.key?.id || null,
        })

        // Salva dados da família extraídos
        if (saraResult.familia_dados) {
          const fd = saraResult.familia_dados
          const update: Record<string, string> = {}
          if (fd.nome_responsavel) update.nome_responsavel = fd.nome_responsavel
          if (fd.email) update.email = fd.email
          if (fd.cep) update.cep = fd.cep
          if (fd.rua) update.rua = fd.rua
          if (fd.numero) update.numero = fd.numero
          if (fd.bairro) update.bairro = fd.bairro
          if (fd.cidade) update.cidade = fd.cidade
          if (fd.estado) update.estado = fd.estado
          if (Object.keys(update).length > 0) {
            await supabase.from('familias').update(update).eq('id', familia.id)
          }
        }

        // Salva/atualiza criança
        if (saraResult.crianca_dados) {
          const cd = saraResult.crianca_dados
          if (cd.nome || cd.idade || cd.serie_desejada || cd.periodo) {
            if (lead.crianca_id) {
              const update: Record<string, string | number> = {}
              if (cd.nome) update.nome = cd.nome
              if (cd.idade) update.idade = cd.idade
              if (cd.data_nascimento) update.data_nascimento = cd.data_nascimento
              if (cd.serie_desejada) update.serie_desejada = cd.serie_desejada
              if (cd.periodo) update.periodo = cd.periodo
              if (Object.keys(update).length > 0) {
                await supabase.from('criancas').update(update).eq('id', lead.crianca_id)
              }
            } else {
              const { data: novaCrianca } = await supabase
                .from('criancas')
                .insert({
                  familia_id: familia.id,
                  nome: cd.nome || 'A confirmar',
                  idade: cd.idade || null,
                  data_nascimento: cd.data_nascimento || null,
                  serie_desejada: cd.serie_desejada || null,
                  periodo: cd.periodo || null,
                })
                .select('id')
                .single()

              if (novaCrianca) {
                await supabase.from('leads').update({ crianca_id: novaCrianca.id }).eq('id', lead.id)
              }
            }
          }
        }

        // Agendamento de visita confirmado pela Sara
        if (saraResult.agendar_visita?.data_hora) {
          const dh = new Date(saraResult.agendar_visita.data_hora)
          if (!isNaN(dh.getTime())) {
            const dhIso = dh.toISOString()
            const { data: jaTem } = await supabase
              .from('tarefas')
              .select('id')
              .eq('lead_id', lead.id)
              .eq('tipo', 'visita')
              .eq('data_hora', dhIso)
              .maybeSingle()

            if (!jaTem) {
              await supabase.from('tarefas').insert({
                lead_id: lead.id,
                titulo: `Visita — ${familia.nome_responsavel || 'Família'}`,
                tipo: 'visita',
                data_hora: dhIso,
              })

              await supabase
                .from('leads')
                .update({ data_proxima_acao: dhIso, proxima_acao: 'Visita agendada' })
                .eq('id', lead.id)

              await supabase
                .from('eventos_timeline')
                .insert({
                  lead_id: lead.id,
                  tipo: 'visita_agendada',
                  descricao: `Sara agendou visita para ${dhIso}`,
                })
                .catch(() => {})
            }
          }
        }

        // Guard-rails movimentação
        if (saraResult.proxima_coluna_id && lead.sara_pode_mover !== false && todasColunas && colunaAtual) {
          const proximaColuna = todasColunas.find((c) => c.id === saraResult.proxima_coluna_id)
          let motivoRecusa: string | null = null

          if (!proximaColuna) motivoRecusa = 'coluna_inexistente'
          else if (proximaColuna.ordem > colunaAtual.ordem + 1) motivoRecusa = `pulou_etapas`
          else if (proximaColuna.ordem <= colunaAtual.ordem) motivoRecusa = `regressao`
          else if (proximaColuna.nome === 'Matriculados') motivoRecusa = 'matriculados_requer_confirmacao_humana'
          else if (proximaColuna.nome === 'Perdidos' && !saraResult.razao_movimentacao) motivoRecusa = 'perdidos_sem_razao'

          if (motivoRecusa) {
            await supabase.from('acoes_sara').insert({
              lead_id: lead.id, tipo: 'movimentacao',
              conteudo: `Recusado: "${proximaColuna?.nome}"`,
              razao: motivoRecusa, sucesso: false,
              coluna_origem_id: colunaAtual.id,
              coluna_destino_id: saraResult.proxima_coluna_id,
            })
          } else if (proximaColuna) {
            await supabase.from('leads').update({
              coluna_id: saraResult.proxima_coluna_id,
              entrou_coluna_em: new Date().toISOString(),
            }).eq('id', lead.id)

            await supabase.from('acoes_sara').insert({
              lead_id: lead.id, tipo: 'movimentacao',
              conteudo: saraResult.razao_movimentacao || `Movido para ${proximaColuna.nome}`,
              razao: saraResult.razao_movimentacao, sucesso: true,
              coluna_origem_id: colunaAtual.id,
              coluna_destino_id: saraResult.proxima_coluna_id,
            })

            await supabase.from('eventos_timeline').insert({
              lead_id: lead.id, tipo: 'movimentacao',
              descricao: `Sara moveu de "${colunaAtual.nome}" para "${proximaColuna.nome}". Motivo: ${saraResult.razao_movimentacao || 'não informado'}`,
            }).catch(() => {})
          }
        }

        // Transbordo
        if (saraResult.transbordo) {
          await supabase.from('leads').update({
            precisa_atendimento_humano: true,
            motivo_transbordo: saraResult.motivo_transbordo,
            transbordo_em: new Date().toISOString(),
            ia_ativa: false,
          }).eq('id', lead.id)

          await supabase.from('acoes_sara').insert({
            lead_id: lead.id, tipo: 'mensagem',
            conteudo: 'Transbordo ativado — Sara pausada',
            razao: saraResult.motivo_transbordo || 'transbordo_detectado',
            sucesso: true,
          })

          const { data: cfgTransbordo } = await supabase
            .from('config_ia')
            .select('telefone_transbordo')
            .eq('id', 1)
            .single()
          const telTransbordo = cfgTransbordo?.telefone_transbordo
          if (telTransbordo) {
            const msg =
              `⚠️ *ATENDIMENTO HUMANO NECESSÁRIO*\n\n` +
              `Família: ${familia.nome_responsavel || 'Desconhecida'}\n` +
              `Telefone: ${telefone}\n` +
              `Motivo: ${saraResult.motivo_transbordo || 'Solicitado pelo lead'}\n\n` +
              `A Sara foi pausada. Acesse o CRM para continuar o atendimento.`

            await evolutionSendText(telTransbordo, msg).catch((e) =>
              console.error('Falha ao notificar transbordo:', e)
            )
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
