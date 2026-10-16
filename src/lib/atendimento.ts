import { createServerAdminClient } from '@/lib/supabase-server'
import { gerarRespostaSara, SaraColuna } from '@/lib/sara'
import { notificarGestor } from '@/lib/notificacoes'
import { labelAcre } from '@/lib/disponibilidade'
import { sleep } from '@/lib/pacing'
import { identificarResponsavel } from '@/lib/sgei'
import { processarMensagemSalomao } from '@/lib/salomao'
import { decidirPolitica } from '@/lib/maestro/politica'
import { detectarOptOut } from '@/lib/maestro/opt-out'
import { validarResposta } from '@/lib/maestro/validar-resposta'
import { registrarDecisaoRoteador } from '@/lib/roteador/log'

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

// Trava de resposta por lead (mutex). O debounce de 15s filtra "existe balão
// mais novo?", mas NÃO impede duas execuções concorrentes de passarem no teste
// quase ao mesmo tempo e responderem o mesmo estado — foi o que duplicou a
// mensagem para o lead do Yuri em 04/09 (mesmo par enviado 2x, gaps de 17s),
// porque o cliente digitou em rajada com mensagens espaçadas ~15s. Aqui só UMA
// execução por lead entra por vez; quem perde a corrida desiste.
//
// Implementado como coluna leads.resposta_lock_em (timestamptz, nullable) em vez
// de advisory lock: o PostgREST roda cada chamada numa transação própria e faz
// pooling de conexão, então um lock de sessão/transação não sobreviveria à
// latência da chamada ao modelo. A trava é considerada OBSOLETA após LOCK_TTL_MS,
// para uma execução que morreu no meio (timeout/erro) não travar o lead p/ sempre.
const LOCK_TTL_MS = 60_000

/** Tenta virar a execução que responde este lead. UPDATE condicional atômico:
 *  o Postgres serializa a trava de linha, então de N execuções concorrentes só a
 *  primeira encontra a coluna livre/obsoleta e vence; as demais recebem 0 linhas. */
async function tentarTravarResposta(supabase: SupaAdmin, leadId: string): Promise<boolean> {
  const obsoleto = new Date(Date.now() - LOCK_TTL_MS).toISOString()
  const { data } = await supabase
    .from('leads')
    .update({ resposta_lock_em: new Date().toISOString() })
    .eq('id', leadId)
    .or(`resposta_lock_em.is.null,resposta_lock_em.lt.${obsoleto}`)
    .select('id')
  return Array.isArray(data) && data.length > 0
}

/** Libera a trava. Sempre chamada no finally, inclusive quando a execução desiste. */
async function liberarTravaResposta(supabase: SupaAdmin, leadId: string): Promise<void> {
  await supabase.from('leads').update({ resposta_lock_em: null }).eq('id', leadId)
}

/** Junta os balões recebidos ('in') desde a última resposta do sistema, para o
 * Salomão considerar a rajada inteira numa resposta só. Se não houver nada,
 * devolve o texto do balão atual (fallback). */
async function juntarBaloesRecebidos(
  supabase: SupaAdmin,
  leadId: string,
  fallback: string
): Promise<string> {
  const { data: ultimaOut } = await supabase
    .from('mensagens')
    .select('criado_em')
    .eq('lead_id', leadId)
    .in('direcao', ['out_ia', 'out_humano'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  let q = supabase
    .from('mensagens')
    .select('conteudo')
    .eq('lead_id', leadId)
    .eq('direcao', 'in')
    .order('criado_em', { ascending: true })
  if (ultimaOut?.criado_em) q = q.gt('criado_em', ultimaOut.criado_em)

  const { data } = await q
  const txt = (data || []).map((m) => m.conteudo).filter(Boolean).join('\n').trim()
  return txt || fallback
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
    agente: 'humano',
    agente_origem: 'conversa',
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

  // Idempotência: se este wid já foi processado (retry do webhook / upsert duplicado),
  // não registra de novo nem roda a Sara — evita respostas duplicadas. Rede de
  // segurança final: índice único parcial em mensagens.whatsapp_message_id.
  if (wid) {
    const { data: jaProcessada } = await supabase
      .from('mensagens')
      .select('id')
      .eq('whatsapp_message_id', wid)
      .maybeSingle()
    if (jaProcessada) return 'duplicada_ignorada'
  }

  let { data: familia } = await supabase
    .from('familias')
    .select('id, nome_responsavel, ja_responsavel')
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
      .select('id, nome_responsavel, ja_responsavel')
      .single()
    familia = ins.data

    // Race do primeiro contato: duas mensagens de um número NOVO chegam quase
    // juntas, nenhuma das duas acha a família e as duas tentam inserir. A segunda
    // bate na constraint única familias_telefone_key (23505) e a mensagem era
    // perdida com "Falha ao criar família" (2 ocorrências em 28/07/2026 20:59:57).
    // Reconsulta em vez de falhar. NÃO usar upsert aqui: ele sobrescreveria a
    // atribuição first-touch (origem, canal, campanha, referral) a cada mensagem.
    if (!familia) {
      const rel = await supabase
        .from('familias')
        .select('id, nome_responsavel, ja_responsavel')
        .eq('telefone', telefone)
        .maybeSingle()
      familia = rel.data
    }
    if (!familia && ins.error) {
      throw new Error(`Falha ao criar família: ${ins.error.message}`)
    }
  }
  if (!familia) throw new Error('Falha ao criar família')

  // Registra por qual número oficial da escola este contato chegou, para os
  // disparos (follow-up, botão, etc.) responderem pelo mesmo número.
  if (phoneNumberId) {
    await supabase.from('familias').update({ whatsapp_phone_number_id: phoneNumberId }).eq('id', familia.id)
  }

  let { data: lead } = await supabase
    .from('leads')
    .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano, no_show_em, reagendamentos_count')
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
      .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano, no_show_em, reagendamentos_count')
      .single()
    lead = ins.data
  }
  if (!lead) throw new Error('Falha ao criar lead')

  const { data: msgInserida } = await supabase.from('mensagens').insert({
    lead_id: lead.id,
    direcao: 'in',
    conteudo,
    whatsapp_message_id: wid,
    tipo_midia: tipoMidia || 'texto',
    url_midia: urlMidia || null,
  }).select('id, criado_em').single()
  const msgInId: string | null = msgInserida?.id ?? null
  const msgInCriadoEm: string | null = msgInserida?.criado_em ?? null

  // Lead respondeu: atualiza última interação e reengaja o follow-up (zera contador)
  await supabase
    .from('leads')
    .update({ ultima_interacao_em: new Date().toISOString(), followup_count: 0, followup_status: 'ativo', precisa_template: false })
    .eq('id', lead.id)

  // Salomão (atendimento a matriculados) — kill switch: config_ia.salomao_ativo.
  // Desligado => comportamento legado (pausa + atendimento humano).
  const { data: cfgIA } = await supabase
    .from('config_ia')
    .select('salomao_ativo')
    .eq('id', 1)
    .maybeSingle()
  const salomaoAtivo = cfgIA?.salomao_ativo === true
  // Flags do Maestro via ambiente (sem depender de schema remoto): default seguro.
  // MAESTRO_ATIVO off => rota idêntica à de sempre. VALIDACAO_SAIDA_MODO em modo
  // sombra ('log') por padrão: só registra o que vetaria, nunca bloqueia o envio.
  const maestroAtivo = process.env.MAESTRO_ATIVO === 'true'
  const validacaoModo: 'off' | 'log' | 'ativo' =
    process.env.VALIDACAO_SAIDA_MODO === 'off'
      ? 'off'
      : process.env.VALIDACAO_SAIDA_MODO === 'ativo'
        ? 'ativo'
        : 'log'
  let jaResponsavel = familia.ja_responsavel === true

  // Integração SGEI — na primeira vez que um contato aparece, verifica se o
  // número já é responsável de aluno matriculado. Se for: joga o lead para o
  // funil "Matriculados" na turma do filho. Com o Salomão ATIVO, a IA continua
  // ligada e o Salomão atende; desligado, pausa a Sara (transbordo) e avisa o
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
          jaResponsavel = true

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

          const upLead: Record<string, unknown> = {}
          if (salomaoAtivo) {
            // Salomão assume: IA continua ativa, sem transbordo automático.
            upLead.ia_ativa = true
          } else {
            // Legado: pausa e encaminha para humano.
            upLead.ia_ativa = false
            upLead.precisa_atendimento_humano = true
            upLead.motivo_transbordo = 'Já é responsável de aluno matriculado (SGEI)'
            upLead.transbordo_em = new Date().toISOString()
          }
          if (colunaDestino) {
            upLead.coluna_id = colunaDestino
            upLead.entrou_coluna_em = new Date().toISOString()
          }
          await supabase.from('leads').update(upLead).eq('id', lead.id)
          // Reflete no objeto em memória para o restante do fluxo.
          lead.ia_ativa = salomaoAtivo
          lead.precisa_atendimento_humano = !salomaoAtivo

          await supabase.from('eventos_timeline').insert({
            lead_id: lead.id,
            tipo: 'status_ia',
            descricao:
              `Contato identificado no SGEI como responsável` +
              (ident.aluno_nome ? ` de ${ident.aluno_nome}` : '') +
              (ident.turma_nome ? ` (${ident.turma_nome})` : '') +
              `. Lead movido para o funil Matriculados` +
              (salomaoAtivo ? ' — Salomão assumiu o atendimento.' : '. Sara pausada — atendimento humano.'),
          })

          if (!salomaoAtivo) {
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
    }
  } catch (e) {
    console.error('Check SGEI (entrada de contato) falhou:', e)
  }

  // ── DEBOUNCE 15s ──────────────────────────────────────────────────────────
  // Agrupa vários balões numa única resposta. Espera 15s; se durante a espera
  // chegar um balão 'in' mais novo (outra execução do webhook), ESTA execução
  // desiste de responder e quem responde é a do último balão. A mensagem em si
  // já foi gravada acima, então ela aparece no CRM na hora — só a RESPOSTA espera.
  // Roda dentro de after() nos webhooks, logo não segura a resposta ao WhatsApp
  // (sem risco de timeout/reenvio). A Sara lê o histórico do lead, então enxerga
  // todos os balões; para o Salomão, juntamos os balões abaixo.
  const JANELA_DEBOUNCE_MS = 15000
  if (msgInId) {
    await sleep(JANELA_DEBOUNCE_MS)
    const { data: ultimaIn } = await supabase
      .from('mensagens')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('direcao', 'in')
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (ultimaIn && ultimaIn.id !== msgInId) {
      return lead.id // chegou balão mais novo — a próxima execução é que responde
    }

    // Somos o último balão: relê o estado atual, pois outros balões da rajada
    // podem ter mudado o lead/família (identificação SGEI, pausa manual, etc.).
    const { data: leadFresh } = await supabase
      .from('leads')
      .select('ia_ativa, precisa_atendimento_humano, coluna_id, sara_pode_mover, crianca_id, no_show_em, reagendamentos_count')
      .eq('id', lead.id)
      .maybeSingle()
    if (leadFresh) {
      lead.ia_ativa = leadFresh.ia_ativa
      lead.precisa_atendimento_humano = leadFresh.precisa_atendimento_humano
      lead.coluna_id = leadFresh.coluna_id
      lead.sara_pode_mover = leadFresh.sara_pode_mover
      lead.crianca_id = leadFresh.crianca_id
      lead.no_show_em = leadFresh.no_show_em
      lead.reagendamentos_count = leadFresh.reagendamentos_count
    }
    const { data: famFresh } = await supabase
      .from('familias')
      .select('ja_responsavel')
      .eq('id', familia.id)
      .maybeSingle()
    if (famFresh) jaResponsavel = famFresh.ja_responsavel === true
  }

  // ── MAESTRO GUARDIÃO ────────────────────────────────────────────────────
  // Decisão única de política + rota, no lugar das condições espalhadas. Com
  // MAESTRO_ATIVO off (default), optOut=false ⇒ a rota é idêntica à de sempre:
  // matriculado→Salomão, novo→Sara, com as guardas de ia_ativa/force_human.
  const optOut = maestroAtivo && detectarOptOut(conteudo)
  const decisao = decidirPolitica({
    optOut,
    precisaAtendimentoHumano: lead.precisa_atendimento_humano === true,
    iaAtiva: lead.ia_ativa,
    jaResponsavel,
    salomaoAtivo,
  })
  if (maestroAtivo) {
    await registrarDecisaoRoteador(supabase, { leadId: lead.id, canal: origem, decisao })
  }

  // Opt-out: cliente pediu para parar. Pausa a IA e não responde. A gravação em
  // familias.opt_out_em é best-effort (a coluna pode ainda não existir no banco;
  // o PostgREST só devolve erro no resultado, não derruba o fluxo).
  if (optOut) {
    await supabase.from('familias').update({ opt_out_em: new Date().toISOString() }).eq('id', familia.id)
    if (lead.ia_ativa) {
      await supabase.from('leads').update({ ia_ativa: false }).eq('id', lead.id)
      await supabase.from('eventos_timeline').insert({
        lead_id: lead.id,
        tipo: 'status_ia',
        descricao: 'IA pausada: lead pediu para parar de receber mensagens (opt-out).',
      })
    }
    return lead.id
  }

  // Portão de saída do Maestro (modo sombra por padrão): confere o texto do agente
  // ANTES de enviar. 'log' só registra o que vetaria (não bloqueia); 'off' desliga.
  // Envolve o envio dos DOIS agentes. O bloqueio real ('ativo') depende da lista de
  // fatos oficiais do proprietário — até lá, 'ativo' também só registra.
  const enviarValidado: EnviarTexto =
    validacaoModo === 'off'
      ? enviarTexto
      : async (telefone, texto) => {
          const r = validarResposta(texto)
          if (!r.ok) {
            console.warn(
              `[maestro/validacao modo=${validacaoModo}] vetaria:`,
              r.vetos.map((v) => `${v.codigo}:${v.trecho}`).join(' | ')
            )
          }
          return enviarTexto(telefone, texto)
        }

  // Responsável MATRICULADO + Salomão ativo => Salomão atende (nunca a Sara).
  // Respeita ADR-005: pausa manual (ia_ativa=false) e transbordo valem igual.
  if (decisao.rota === 'salomao') {
    if (lead.ia_ativa && !lead.precisa_atendimento_humano) {
      // TRAVA DE RESPOSTA (mutex por lead) — mesma da Sara. O debounce de 15s
      // agrupa a rajada, mas NÃO impede duas execuções concorrentes de passarem
      // quase juntas (webhook reentregue, balões espaçados ~15s). O Salomão faz
      // efeitos sensíveis (gera PIX, registra recado), então precisa da trava
      // tanto quanto a Sara. Quem perde a corrida desiste.
      const travou = await tentarTravarResposta(supabase, lead.id)
      if (!travou) return lead.id
      try {
        // Uma execução anterior da mesma rajada já respondeu DEPOIS desta
        // mensagem? Então não responda de novo (paridade com a Sara).
        if (msgInCriadoEm) {
          const { data: jaRespondida } = await supabase
            .from('mensagens')
            .select('id')
            .eq('lead_id', lead.id)
            .eq('direcao', 'out_ia')
            .gt('criado_em', msgInCriadoEm)
            .limit(1)
            .maybeSingle()
          if (jaRespondida) return lead.id
        }

        const conteudoBurst = await juntarBaloesRecebidos(supabase, lead.id, conteudo)
        await processarMensagemSalomao(supabase, {
          leadId: lead.id,
          telefone,
          nomeFamilia: familia.nome_responsavel || 'Família',
          conteudoIn: conteudoBurst,
          enviarTexto: enviarValidado,
        })
      } catch (e) {
        console.error('Salomão falhou:', e)
      } finally {
        await liberarTravaResposta(supabase, lead.id)
      }
    }
    return lead.id
  }

  // Guarda: família matriculada NUNCA cai na Sara (mesmo com Salomão desligado
  // e ia_ativa=true por qualquer motivo). Com o switch off, quem atende é humano.
  if (jaResponsavel) return lead.id

  if (decisao.rota === 'sara') {
    // ── TRAVA DE RESPOSTA (mutex por lead) ────────────────────────────────
    // Só UMA execução responde por vez. Complementa o debounce de 15s: mata a
    // duplicata em rajada e a reentrega de webhook pela Meta. Quem perde, desiste.
    const travou = await tentarTravarResposta(supabase, lead.id)
    if (!travou) return lead.id
    try {
      // Uma execução anterior da mesma rajada já respondeu DEPOIS desta mensagem?
      // (ela venceu a corrida e a resposta dela, lida do histórico completo, já
      // cobre este balão.) Então não responda de novo.
      if (msgInCriadoEm) {
        const { data: jaRespondida } = await supabase
          .from('mensagens')
          .select('id')
          .eq('lead_id', lead.id)
          .eq('direcao', 'out_ia')
          .gt('criado_em', msgInCriadoEm)
          .limit(1)
          .maybeSingle()
        if (jaRespondida) return lead.id
      }

      // AUDITORIA CMO 2026-07-29 — filtrar pelo funil do lead é OBRIGATÓRIO.
      // Existem dois funis: "Captação de matrículas" (Capturados > ... > Perdidos)
      // e "Matriculados" (Berçário I > ... > G5), e a `ordem` COLIDE entre eles
      // (Berçário I e Capturados são ambos ordem 1; G3 e Visita Realizada, ordem 4).
      // Sem este filtro a Sara recebia as 14 colunas dos dois quadros e podia mover
      // um lead de Capturados direto para "G3", que é coluna de turma, sumindo com
      // ele do funil de captação.
      const { data: colunaDoLead } = await supabase
        .from('colunas')
        .select('funil_id')
        .eq('id', lead.coluna_id)
        .maybeSingle()

      const { data: todasColunas } = colunaDoLead?.funil_id
        ? await supabase
            .from('colunas')
            .select('id, nome, ordem')
            .eq('funil_id', colunaDoLead.funil_id)
            .order('ordem')
        : { data: null }

      const colunaAtual = todasColunas?.find((c) => c.id === lead!.coluna_id) as SaraColuna | undefined

      const saraResult = await gerarRespostaSara(
        lead.id,
        todasColunas as SaraColuna[] | undefined,
        colunaAtual
      )

      // Envia em balões curtos (uma mensagem por parágrafo), conforme o manual.
      const baloes = dividirEmBaloes(saraResult.resposta)
      for (let i = 0; i < baloes.length; i++) {
        const sentId = await enviarValidado(telefone, baloes[i])
        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          agente: 'sara',
          agente_origem: 'conversa',
          conteudo: baloes[i],
          whatsapp_message_id: sentId,
        })
        if (i < baloes.length - 1) await sleep(900)
      }

      // Candidato a vaga/currículo: já foi orientado a mandar por e-mail — arquiva e encerra.
      if (saraResult.arquivar) {
        await supabase.from('leads').update({ arquivado: true, ia_ativa: false }).eq('id', lead.id)
        await supabase.from('acoes_sara').insert({
          lead_id: lead.id,
          tipo: 'movimentacao',
          conteudo: saraResult.motivo_arquivamento || 'Arquivado: candidato a vaga',
          razao: 'candidato_vaga',
          sucesso: true,
        })
        await supabase.from('eventos_timeline').insert({
          lead_id: lead.id,
          tipo: 'movimentacao',
          descricao: saraResult.motivo_arquivamento || 'Arquivado (candidato a vaga de emprego).',
        })
        return lead.id
      }

      // Confirmação ativa de visita: registra quando o lead responde "SIM" à confirmação.
      if (
        colunaAtual?.nome === 'Visita Agendada' &&
        /\b(sim|confirmo|confirmado|vou|pode|isso|ok|blz|beleza)\b/i.test(conteudo)
      ) {
        await supabase
          .from('leads')
          .update({ visita_confirmada_em: new Date().toISOString(), risco_no_show: false })
          .eq('id', lead.id)
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
        if (cd.nome || cd.idade || cd.serie_desejada || cd.periodo || cd.motivo_busca) {
          if (lead.crianca_id) {
            const update: Record<string, string | number> = {}
            if (cd.nome) update.nome = cd.nome
            if (cd.idade) update.idade = cd.idade
            if (cd.data_nascimento) update.data_nascimento = cd.data_nascimento
            if (cd.serie_desejada) update.serie_desejada = cd.serie_desejada
            if (cd.periodo) update.periodo = cd.periodo
            if (cd.motivo_busca) update.motivo_busca = cd.motivo_busca
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
                motivo_busca: cd.motivo_busca || null,
              })
              .select('id')
              .single()

            if (novaCrianca) {
              await supabase.from('leads').update({ crianca_id: novaCrianca.id }).eq('id', lead.id)
            }
          }
        }
      }

      // Agendamento de visita confirmado pela Sara. TRAVA (2026-09-02): só cria a
      // tarefa/evento na agenda com um horário CONCRETO e FUTURO — a família escolheu
      // uma das opções oferecidas. Interesse vago ou pedido de prazo NÃO agenda.
      let temSlotVisita = false
      if (saraResult.agendar_visita?.data_hora) {
        const dh = new Date(saraResult.agendar_visita.data_hora)
        if (!isNaN(dh.getTime()) && dh.getTime() > Date.now()) {
          temSlotVisita = true
          const dhIso = dh.toISOString()

          // REAGENDAMENTO (2026-09-16): antes o dedup era só por horário EXATO, então
          // toda mudança de horário criava uma tarefa NOVA e deixava a antiga órfã
          // (visita duplicada — caso da Bruna). Agora: se já existe uma visita futura
          // não concluída, ATUALIZA o horário dela; só insere quando não há nenhuma.
          const { data: visitaAberta } = await supabase
            .from('tarefas')
            .select('id, data_hora')
            .eq('lead_id', lead.id)
            .eq('tipo', 'visita')
            .eq('concluida', false)
            .gte('data_hora', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
            .order('data_hora', { ascending: true })
            .limit(1)
            .maybeSingle()

          const mesmoHorario = visitaAberta && new Date(visitaAberta.data_hora).getTime() === dh.getTime()

          if (!mesmoHorario) {
            const reagendou = !!visitaAberta
            if (visitaAberta) {
              await supabase.from('tarefas').update({ data_hora: dhIso }).eq('id', visitaAberta.id)
            } else {
              await supabase.from('tarefas').insert({
                lead_id: lead.id,
                titulo: `Visita — ${familia.nome_responsavel || 'Família'}`,
                tipo: 'visita',
                data_hora: dhIso,
              })
            }
            await supabase
              .from('leads')
              .update({ data_proxima_acao: dhIso, proxima_acao: 'Visita agendada' })
              .eq('id', lead.id)
            // Se o lead estava em no-show, o reagendamento o tira desse estado (e conta a tentativa).
            if (lead.no_show_em) {
              await supabase
                .from('leads')
                .update({
                  no_show_em: null,
                  risco_no_show: false,
                  reagendamentos_count: (lead.reagendamentos_count ?? 0) + 1,
                })
                .eq('id', lead.id)
              lead.no_show_em = null
            }
            await supabase.from('eventos_timeline').insert({
              lead_id: lead.id,
              tipo: 'visita_agendada',
              descricao: `Sara ${reagendou ? 'reagendou' : 'agendou'} visita para ${dhIso}`,
            })
            await notificarGestor(
              supabase,
              'visita',
              `📅 *Visita ${reagendou ? 'reagendada' : 'agendada'} pela Sara*\nFamília: ${familia.nome_responsavel || 'Família'}\nQuando: ${labelAcre(dh)}`
            )
          }
        }
      }

      // Se a Sara não agendou um slot neste turno, o lead ainda pode ir para
      // "Visita Agendada" caso JÁ exista uma tarefa de visita futura (ex.: visita
      // marcada manualmente pelo gestor, ou num turno anterior).
      if (!temSlotVisita) {
        const { data: visitaFutura } = await supabase
          .from('tarefas')
          .select('id')
          .eq('lead_id', lead.id)
          .eq('tipo', 'visita')
          .eq('concluida', false)
          .gte('data_hora', new Date().toISOString())
          .limit(1)
          .maybeSingle()
        if (visitaFutura) temSlotVisita = true
      }

      // Guard-rails de movimentação
      if (saraResult.proxima_coluna_id && lead.sara_pode_mover !== false && todasColunas && colunaAtual) {
        const proximaColuna = todasColunas.find((c) => c.id === saraResult.proxima_coluna_id)
        let motivoRecusa: string | null = null

        if (!proximaColuna) motivoRecusa = 'coluna_inexistente'
        else if (proximaColuna.ordem > colunaAtual.ordem + 1) motivoRecusa = 'pulou_etapas'
        else if (proximaColuna.ordem <= colunaAtual.ordem) motivoRecusa = 'regressao'
        else if (proximaColuna.nome === 'Matriculados') motivoRecusa = 'matriculados_requer_confirmacao_humana'
        // TRAVA (2026-09-02): "Visita Agendada" exige um horário REAL marcado. Sem
        // isso, "confirmações" vagas ("vou ver minha folga", "volto pra marcar",
        // "daqui a 3 semanas") empurravam o lead para cá sem data — e o follow-up de
        // confirmação, que depende da tarefa de visita, nunca disparava.
        else if (proximaColuna.nome === 'Visita Agendada' && !temSlotVisita) motivoRecusa = 'visita_agendada_sem_horario'
        // NO-SHOW (2026-08-13): a Sara não pode marcar que a visita ocorreu — ela não tem
        // como saber se a família compareceu. "Visita Realizada" é sempre movimentação manual.
        else if (proximaColuna.nome === 'Visita Realizada') motivoRecusa = 'visita_realizada_requer_confirmacao_humana'
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
    } finally {
      // Libera a trava mesmo em erro ou desistência — o próximo balão real do
      // cliente (após esta resposta) poderá ser atendido normalmente.
      await liberarTravaResposta(supabase, lead.id)
    }
  }

  return lead.id
}
