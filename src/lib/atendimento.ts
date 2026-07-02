import { createServerAdminClient } from '@/lib/supabase-server'
import { gerarRespostaSara, SaraColuna } from '@/lib/sara'
import { notificarGestor } from '@/lib/notificacoes'
import { labelAcre } from '@/lib/disponibilidade'

// Lógica de atendimento compartilhada pelos webhooks (Evolution e WhatsApp Cloud).
// Cada canal só faz o parsing do payload e passa uma função de envio.

type SupaAdmin = ReturnType<typeof createServerAdminClient>

/** Envia um texto pelo canal e devolve o id da mensagem (ou null). */
export type EnviarTexto = (telefone: string, texto: string) => Promise<string | null>

/**
 * ADR-005: mensagem enviada pelo próprio número (fromMe). Se for da Sara (via API)
 * já está registrada -> ignora. Se for manual (equipe pelo celular) -> grava como
 * out_humano e pausa a Sara (handoff). Retorna um status para log.
 */
export async function registrarMensagemManual(
  supabase: SupaAdmin,
  params: { telefone: string; conteudo: string; wid: string }
): Promise<string> {
  const { telefone, conteudo, wid } = params

  if (wid) {
    const { data: jaExiste } = await supabase
      .from('mensagens')
      .select('id')
      .eq('whatsapp_message_id', wid)
      .maybeSingle()
    if (jaExiste) return 'fromMe_sara'
  }

  const { data: fam } = await supabase
    .from('familias')
    .select('id')
    .eq('telefone', telefone)
    .maybeSingle()
  if (!fam) return 'fromMe_sem_familia'

  const { data: lead } = await supabase
    .from('leads')
    .select('id, ia_ativa')
    .eq('familia_id', fam.id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!lead) return 'fromMe_sem_lead'

  await supabase.from('mensagens').insert({
    lead_id: lead.id,
    direcao: 'out_humano',
    conteudo,
    whatsapp_message_id: wid || null,
  })

  if (lead.ia_ativa) {
    await supabase.from('leads').update({ ia_ativa: false }).eq('id', lead.id)
    await supabase.from('eventos_timeline').insert({
      lead_id: lead.id,
      tipo: 'status_ia',
      descricao: 'Sara pausada: atendente respondeu manualmente pelo WhatsApp',
    })
  }

  return 'registrado_out_humano'
}

/**
 * Fluxo principal de uma mensagem recebida de um lead: acha/cria família e lead,
 * registra a mensagem, roda a Sara e persiste (dados, agendamento, movimentação,
 * transbordo). Usado pelos dois webhooks.
 */
export async function processarMensagemRecebida(
  supabase: SupaAdmin,
  params: {
    telefone: string
    conteudo: string
    pushName: string
    wid: string
    origem: string // familias.origem
    tag: string // tag inicial do lead
    enviarTexto: EnviarTexto
    canal?: string // 'meta-ads' | 'organico' ... (atribuição first-touch)
    campanha?: string | null
    referral?: unknown // payload bruto do anúncio, para auditoria
  }
): Promise<string> {
  const { telefone, conteudo, pushName, wid, origem, tag, enviarTexto, canal, campanha, referral } = params

  let { data: familia } = await supabase
    .from('familias')
    .select('id, nome_responsavel')
    .eq('telefone', telefone)
    .maybeSingle()

  if (!familia) {
    const ins = await supabase
      .from('familias')
      .insert({
        nome_responsavel: pushName,
        telefone,
        origem,
        canal: canal || 'organico',
        campanha: campanha || null,
        referral: (referral as object | null) ?? null,
      })
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
        tags: [tag],
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

  // Lead respondeu: atualiza última interação e reengaja o follow-up (zera contador)
  await supabase
    .from('leads')
    .update({ ultima_interacao_em: new Date().toISOString(), followup_count: 0, followup_status: 'ativo' })
    .eq('id', lead.id)

  if (lead.ia_ativa && !lead.precisa_atendimento_humano) {
    try {
      const { data: todasColunas } = await supabase
        .from('colunas')
        .select('id, nome, ordem')
        .order('ordem')

      const colunaAtual = todasColunas?.find((c) => c.id === lead!.coluna_id) as SaraColuna | undefined

      const saraResult = await gerarRespostaSara(
        lead.id,
        todasColunas as SaraColuna[] | undefined,
        colunaAtual
      )

      const sentId = await enviarTexto(telefone, saraResult.resposta)

      await supabase.from('mensagens').insert({
        lead_id: lead.id,
        direcao: 'out_ia',
        conteudo: saraResult.resposta,
        whatsapp_message_id: sentId,
      })

      // Dados da família extraídos
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

      // Criança
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
            await supabase.from('eventos_timeline').insert({
              lead_id: lead.id,
              tipo: 'visita_agendada',
              descricao: `Sara agendou visita para ${dhIso}`,
            })
            await notificarGestor(
              supabase,
              'visita',
              `📅 *Visita agendada pela Sara*\nFamília: ${familia.nome_responsavel || 'Família'}\nQuando: ${labelAcre(dh)}`
            )
          }
        }
      }

      // Guard-rails de movimentação
      if (saraResult.proxima_coluna_id && lead.sara_pode_mover !== false && todasColunas && colunaAtual) {
        const proximaColuna = todasColunas.find((c) => c.id === saraResult.proxima_coluna_id)
        let motivoRecusa: string | null = null

        if (!proximaColuna) motivoRecusa = 'coluna_inexistente'
        else if (proximaColuna.ordem > colunaAtual.ordem + 1) motivoRecusa = 'pulou_etapas'
        else if (proximaColuna.ordem <= colunaAtual.ordem) motivoRecusa = 'regressao'
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
          })

          if (proximaColuna.nome === 'Perdidos') {
            await notificarGestor(
              supabase,
              'encerramento',
              `🚫 *Atendimento encerrado — Perdido*\nFamília: ${familia.nome_responsavel || 'Família'}\nMotivo: ${saraResult.razao_movimentacao || 'não informado'}`
            )
          }
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
          await enviarTexto(telTransbordo, msg).catch(() => null)
        }
      }
    } catch (e) {
      console.error('Sara IA falhou:', e)
    }
  }

  return lead.id
}
