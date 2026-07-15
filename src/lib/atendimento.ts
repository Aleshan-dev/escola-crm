import { createServerAdminClient } from '@/lib/supabase-server'
import { gerarRespostaSara, SaraColuna } from '@/lib/sara'
import { notificarGestor } from '@/lib/notificacoes'
import { labelAcre } from '@/lib/disponibilidade'
import { sleep } from '@/lib/pacing'
import { identificarResponsavel } from '@/lib/sgei'

// Lógica de atendimento compartilhada pelos webhooks (Evolution e WhatsApp Cloud).
// Cada canal só faz o parsing do payload e passa uma função de envio.

type SupaAdmin = ReturnType<typeof createServerAdminClient>

/** Envia um texto pelo canal e devolve o id da mensagem (ou null). */
export type EnviarTexto = (telefone: string, texto: string) => Promise<string | null>

/** Quebra a resposta da Sara em balões curtos (máx. 3) — como o manual pede.
 * Primeiro tenta por parágrafos (linha em branco); se vier um bloco único longo,
 * quebra por frases em pedaços de ~160 caracteres. */
export function dividirEmBaloes(texto: string): string[] {
  const porParagrafo = texto.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  let baloes = porParagrafo.length ? porParagrafo : [texto.trim()]

  if (baloes.length === 1 && baloes[0].length > 200) {
    const frases = baloes[0].match(/[^.!?]+[.!?]*\s*/g)?.map((s) => s.trim()).filter(Boolean) || [baloes[0]]
    baloes = []
    let atual = ''
    for (const f of frases) {
      if (atual && (atual + ' ' + f).length > 160) { baloes.push(atual); atual = f }
      else atual = atual ? `${atual} ${f}` : f
    }
    if (atual) baloes.push(atual)
  }

  return baloes.map((b) => b.trim()).filter(Boolean).slice(0, 3)
}

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
    phoneNumberId?: string | null // número oficial da escola que recebeu a mensagem
    tipoMidia?: string // 'texto' | 'imagem' | 'audio' | 'documento' | 'video'
    urlMidia?: string | null // caminho do arquivo no storage (bucket 'midias')
  }
): Promise<string> {
  const { telefone, conteudo, pushName, wid, origem, tag, enviarTexto, canal, campanha, referral, phoneNumberId, tipoMidia, urlMidia } = params

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

  // Registra por qual número oficial da escola este contato chegou, para os
  // disparos (follow-up, botão, etc.) responderem pelo mesmo número.
  if (phoneNumberId) {
    await supabase.from('familias').update({ whatsapp_phone_number_id: phoneNumberId }).eq('id', familia.id)
  }

  let { data: lead } = await supabase
    .from('leads')
    .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano')
    .eq('familia_id', familia.id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!lead) {
    // Primeira coluna do funil PADRÃO (captação) — não pode cair numa turma do
    // funil Matriculados só porque a ordem coincide.
    const { data: funilPadrao } = await supabase
      .from('funis')
      .select('id')
      .eq('is_padrao', true)
      .limit(1)
      .maybeSingle()

    let colunaQuery = supabase.from('colunas').select('id, ia_ativa_default').order('ordem').limit(1)
    if (funilPadrao?.id) colunaQuery = colunaQuery.eq('funil_id', funilPadrao.id)
    const { data: primeiraColuna } = await colunaQuery.single()

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
    tipo_midia: tipoMidia || 'texto',
    url_midia: urlMidia || null,
  })

  // Lead respondeu: atualiza última interação e reengaja o follow-up (zera contador)
  await supabase
    .from('leads')
    .update({ ultima_interacao_em: new Date().toISOString(), followup_count: 0, followup_status: 'ativo' })
    .eq('id', lead.id)

  // Integração SGEI — na primeira vez que um contato aparece, verifica se o
  // número já é responsável de aluno matriculado. Se for: joga o lead para o
  // funil "Matriculados" na turma do filho, pausa a Sara (transbordo) e avisa o
  // gestor. Roda uma única vez por família (guarda em familias.sgei_checado_em).
  try {
    const { data: famChk } = await supabase
      .from('familias')
      .select('sgei_checado_em')
      .eq('id', familia.id)
      .single()

    if (!famChk?.sgei_checado_em) {
      const ident = await identificarResponsavel(telefone)
      if (ident) {
        await supabase
          .from('familias')
          .update({
            sgei_checado_em: new Date().toISOString(),
            ja_responsavel: ident.ja_responsavel,
            sgei_nome: ident.nome ?? null,
            sgei_vinculo_ativo: ident.vinculo_ativo ?? null,
          })
          .eq('id', familia.id)

        if (ident.ja_responsavel) {
          // Coluna da turma no funil Matriculados (se a turma for conhecida).
          let colunaDestino: string | null = null
          if (ident.turma_id) {
            const { data: colTurma } = await supabase
              .from('colunas')
              .select('id')
              .eq('sgei_turma_id', ident.turma_id)
              .maybeSingle()
            colunaDestino = colTurma?.id ?? null
          }

          const upLead: Record<string, unknown> = {
            ia_ativa: false,
            precisa_atendimento_humano: true,
            motivo_transbordo: 'Já é responsável de aluno matriculado (SGEI)',
            transbordo_em: new Date().toISOString(),
          }
          if (colunaDestino) {
            upLead.coluna_id = colunaDestino
            upLead.entrou_coluna_em = new Date().toISOString()
          }
          await supabase.from('leads').update(upLead).eq('id', lead.id)
          // Reflete no objeto em memória para o restante do fluxo pular a Sara.
          lead.ia_ativa = false
          lead.precisa_atendimento_humano = true

          await supabase.from('eventos_timeline').insert({
            lead_id: lead.id,
            tipo: 'status_ia',
            descricao:
              `Contato identificado no SGEI como responsável` +
              (ident.aluno_nome ? ` de ${ident.aluno_nome}` : '') +
              (ident.turma_nome ? ` (${ident.turma_nome})` : '') +
              `. Sara pausada e lead movido para o funil Matriculados.`,
          })

          await notificarGestor(
            supabase,
            'transbordo',
            `👨‍👩‍👧 *Responsável já matriculado entrou em contato*\n` +
              `Nome: ${familia.nome_responsavel || ident.nome || 'Família'}\n` +
              (ident.aluno_nome ? `Aluno: ${ident.aluno_nome}\n` : '') +
              (ident.turma_nome ? `Turma: ${ident.turma_nome}\n` : '') +
              `Telefone: ${telefone}\n\n` +
              `A Sara foi pausada e o contato está no funil *Matriculados*. Atenda pelo CRM.`
          )
        }
      }
    }
  } catch (e) {
    console.error('Check SGEI (entrada de contato) falhou:', e)
  }

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

      // Envia em balões curtos (uma mensagem por parágrafo), conforme o manual.
      const baloes = dividirEmBaloes(saraResult.resposta)
      for (let i = 0; i < baloes.length; i++) {
        const sentId = await enviarTexto(telefone, baloes[i])
        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          conteudo: baloes[i],
          whatsapp_message_id: sentId,
        })
        if (i < baloes.length - 1) await sleep(900)
      }

      // Análise cognitiva (5.1): grava o snapshot no lead (contexto interno do CRM).
      if (saraResult.analise) {
        const a = saraResult.analise
        await supabase.from('leads').update({
          cog_intencao: a.intencao,
          cog_emocao: a.emocao,
          cog_temperatura: a.temperatura,
          cog_interesse: a.interesse,
          cog_urgencia: a.urgencia,
          cog_probabilidade: a.probabilidade,
          cog_proxima_acao: a.proxima_acao,
          cog_atualizado_em: new Date().toISOString(),
        }).eq('id', lead.id)
      }

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

      // Agendamento de visita confirmado pela Sara. Se já existe uma visita não
      // concluída, REAGENDA (atualiza a mesma tarefa) em vez de duplicar.
      if (saraResult.agendar_visita?.data_hora) {
        const dh = new Date(saraResult.agendar_visita.data_hora)
        if (!isNaN(dh.getTime())) {
          const dhIso = dh.toISOString()
          const { data: visitaExistente } = await supabase
            .from('tarefas')
            .select('id, data_hora')
            .eq('lead_id', lead.id)
            .eq('tipo', 'visita')
            .eq('concluida', false)
            .order('data_hora', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (visitaExistente) {
            // Reagendamento: só age se o horário realmente mudou.
            if (visitaExistente.data_hora !== dhIso) {
              await supabase.from('tarefas').update({ data_hora: dhIso }).eq('id', visitaExistente.id)
              await supabase
                .from('leads')
                .update({ data_proxima_acao: dhIso, proxima_acao: 'Visita reagendada' })
                .eq('id', lead.id)
              await supabase.from('eventos_timeline').insert({
                lead_id: lead.id,
                tipo: 'visita_agendada',
                descricao: `Sara reagendou a visita para ${dhIso}`,
              })
              await notificarGestor(
                supabase,
                'visita',
                `🔁 *Visita reagendada pela Sara*\nFamília: ${familia.nome_responsavel || 'Família'}\nNovo horário: ${labelAcre(dh)}`
              )
            }
          } else {
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
        else if (/visita\s*agendada/i.test(proximaColuna.nome) && !saraResult.agendar_visita?.data_hora)
          motivoRecusa = 'visita_sem_agendamento' // #7: só entra em Visita Agendada após agendar de fato
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

      // Anotação automática: registra um resumo interno quando há fato novo na conversa.
      if (saraResult.resumo_anotacao && saraResult.resumo_anotacao.trim()) {
        await supabase.from('anotacoes').insert({
          lead_id: lead.id,
          conteudo: saraResult.resumo_anotacao.trim(),
        })
      }

      // Sugestão de matrícula: a Sara sinaliza; o gestor confirma movendo para "Matriculados".
      // Update condicional (só quando ainda era false) evita notificar o gestor repetidamente.
      if (saraResult.sugerir_matricula) {
        const { data: flip } = await supabase
          .from('leads')
          .update({ sugestao_matricula: true, sugestao_matricula_em: new Date().toISOString() })
          .eq('id', lead.id)
          .eq('sugestao_matricula', false)
          .select('id')
        if (flip && flip.length > 0) {
          await supabase.from('eventos_timeline').insert({
            lead_id: lead.id,
            tipo: 'sugestao_matricula',
            descricao: 'Sara sinalizou que a família confirmou matrícula — aguardando confirmação do gestor.',
          })
          await notificarGestor(
            supabase,
            'sugestao_matricula',
            `📝 *Sara sugere matrícula*\nFamília: ${familia.nome_responsavel || 'Família'}\nTelefone: ${telefone}\nConfirme movendo o lead para "Matriculados".`
          )
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
