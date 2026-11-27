import { createServerAdminClient } from '@/lib/supabase-server'
import { gerarRespostaSara, SaraColuna } from '@/lib/sara'
import { completarDadosLead, salvarDadosLead, nomePessoaValido } from '@/lib/dados-lead'
import { notificarGestor } from '@/lib/notificacoes'
import { labelAcre, dentroDaJanelaVisita, ACRE_SHIFT_MS, acreWallToUtc } from '@/lib/disponibilidade'
import { assinar } from '@/lib/assinatura'
import { sleep } from '@/lib/pacing'
import { identificarResponsavel } from '@/lib/sgei'
import { processarMensagemSalomao } from '@/lib/salomao'
import { decidirPolitica } from '@/lib/maestro/politica'
import { detectarOptOut } from '@/lib/maestro/opt-out'
import { validarResposta } from '@/lib/maestro/validar-resposta'
import { registrarDecisaoRoteador } from '@/lib/roteador/log'
import { encaminharParaHumano, resolverTurno } from '@/lib/roteador/turno'
import { protegerEnviarTexto } from '@/lib/envio/portao'
import type { Canal } from '@/lib/envio/defaults'
import { dividirEmBaloes } from '@/lib/baloes'
import { cancelarCasoDoLead, casoAbertoDoLead, executarRespostaEquipe, lerConfigCasos } from '@/lib/casos/servico'
import { executarRetornoCaso } from '@/lib/casos/retorno'
import { aplicarCasosDoTurno } from '@/lib/casos/turno'
import { aplicarMemoriaDoTurno } from '@/lib/memoria/servico'
import { INSTRUCAO_REFORCO, detectaPromessaHumana, modoGuarda } from '@/lib/casos/guarda-promessa'
import { validarAbertura } from '@/lib/casos/regras'
import { normalizarCelular } from '@/lib/telefone'
import { registrarAlerta } from '@/lib/alertas'
import { agendarLigacaoDirecao } from '@/lib/ligacao-direcao'
import {
  afirmaAgendamento,
  casarSlotAfirmado as casarSlotGuarda,
  conferirSlotComTexto,
  ehOfertaDeHorarios,
  textoCitaInstante,
} from '@/lib/agendamento-guarda'

// Lógica de atendimento compartilhada pelos webhooks (Evolution e WhatsApp Cloud).
// Cada canal só faz o parsing do payload e passa uma função de envio.

type SupaAdmin = ReturnType<typeof createServerAdminClient>

// FIX agendamento (2026-11-11): quando a Sara AFIRMA a visita no texto mas não preenche
// `agendar_visita`, o dia+hora afirmados são casados com UM slot ofertado neste turno.
// A função mora em src/lib/agendamento-guarda.ts (casarSlotAfirmado), com as guardas do
// caso Amanda (oferta de horários nunca é confirmação; slot_id conferido com o texto).

// Chave de identidade do contato (espelho de crm.fn_normalizar_celular). Mora em
// src/lib/telefone.ts; reexportado aqui para os importadores antigos.
export { normalizarCelular }

/** Canal físico de uma mensagem, gravado junto na linha de crm.mensagens. */
export type CarimboCanal = { canal_whatsapp: Canal; canal_ref: string | null }

/**
 * Envia um texto pelo canal e devolve o id da mensagem (ou null). `carimbo`
 * (opcional) diz por qual canal ele sai, para quem grava a mensagem enviada.
 */
export type EnviarTexto = ((telefone: string, texto: string) => Promise<string | null>) & { carimbo?: CarimboCanal }

// Mora em src/lib/baloes.ts (o retorno dos Casos também usa); reexportado aqui
// para os importadores antigos.
export { dividirEmBaloes }

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
// Janela em que um fromMe logo após um out_ia nosso é tratado como ECO de balão (não
// handoff humano) — vale para qualquer caminho de envio, inclusive os que não seguram a
// trava de resposta. Curta de propósito, para não mascarar um atendente que assume.
const ECO_OUT_IA_JANELA_MS = 20_000

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

/**
 * Fase 3 do handoff em voo: um humano ASSUMIU pelo celular desde `desde`?
 * Com a atribuição por ledger (registrarMensagemManual), um `out_humano` só é gravado
 * para uma resposta humana de verdade — então, antes de cada balão, se já apareceu um
 * out_humano neste turno, a Sara PARA de enviar o resto (não fala por cima do atendente).
 * Caso Cris Ferreira (03/11): o humano respondeu no aparelho ANTES do 1º balão da Sara.
 */
export async function humanoAssumiu(supabase: SupaAdmin, leadId: string, desde: string): Promise<boolean> {
  const { data } = await supabase
    .from('mensagens')
    .select('id')
    .eq('lead_id', leadId)
    .eq('direcao', 'out_humano')
    .gt('criado_em', desde)
    .limit(1)
    .maybeSingle()
  return data != null
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
  params: {
    telefone: string; conteudo: string; wid: string; canal?: Canal; canalRef?: string | null
    /** false = só carimba a mensagem; a conversa NÃO passa a sair por este canal. */
    carimbarFamilia?: boolean
  }
): Promise<string> {
  const { telefone, conteudo, wid, canal, canalRef, carimbarFamilia = true } = params

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
    .eq('telefone_norm', normalizarCelular(telefone))
    .order('criado_em', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!fam) return 'fromMe_sem_familia'

  const { data: lead } = await supabase
    .from('leads')
    .select('id, ia_ativa, resposta_lock_em')
    .eq('familia_id', fam.id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!lead) return 'fromMe_sem_lead'

  // ATRIBUIÇÃO AUTORITATIVA POR wid (ledger crm.wid_enviado): todo envio NOSSO pelo
  // WAHA grava o wid no ledger ANTES de o chamador seguir (ver registrarWidEnviado em
  // src/lib/waha.ts), então o wid já está no banco quando o eco chega. Logo:
  //   wid NO ledger        ⇒ eco da própria Sara (ou equipe respondendo pelo app) → out_ia, NÃO pausa.
  //   wid AUSENTE do ledger ⇒ mensagem DIGITADA NO CELULAR por um humano → out_humano + PAUSA,
  //                           mesmo com o lock fresco.
  // Isto SUBSTITUI o antigo palpite "lock fresco ⇒ Sara", que rotulava como Sara uma
  // resposta manual feita no aparelho enquanto a Sara gerava a dela — a IA seguia falando
  // por cima e a timeline mentia (caso Cris Ferreira, 03/11). O risco assimétrico (rotular
  // eco da Sara como humano = ela se cala em TODO lead) fica coberto porque o ledger é
  // escrito no ponto único de envio (Sara-conversa, botão "responder agora", follow-up,
  // Casos, resgate). O dedupe por wid (acima) e o 23505 (abaixo) seguem como rede de segurança.
  let nossoEnvio = false
  if (wid) {
    const { data: doLedger } = await supabase
      .from('wid_enviado')
      .select('wid')
      .eq('wid', wid)
      .maybeSingle()
    nossoEnvio = doLedger != null
  } else {
    // Edge sem wid: não dá para casar no ledger. Mantém o sinal antigo de lock/recência,
    // conservador para NUNCA calar a Sara no próprio eco.
    const lockFresco = lead.resposta_lock_em != null
      && Date.now() - new Date(lead.resposta_lock_em as string).getTime() < LOCK_TTL_MS
    let outIaRecente = false
    if (!lockFresco) {
      const limite = new Date(Date.now() - ECO_OUT_IA_JANELA_MS).toISOString()
      const { data: ultimaOutIa } = await supabase
        .from('mensagens')
        .select('id')
        .eq('lead_id', lead.id)
        .eq('direcao', 'out_ia')
        .gt('criado_em', limite)
        .limit(1)
        .maybeSingle()
      outIaRecente = ultimaOutIa != null
    }
    nossoEnvio = lockFresco || outIaRecente
  }

  if (nossoEnvio) {
    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'out_ia',
      agente: 'sara',
      agente_origem: 'conversa',
      conteudo,
      whatsapp_message_id: wid || null,
      ...(canal ? { canal_whatsapp: canal, canal_ref: canalRef ?? null } : {}),
    }) // 23505 aqui = o app já gravou o out_ia deste balão; mesma linha, pode ignorar
    return 'fromMe_sara'
  }

  const { error: erroInsert } = await supabase.from('mensagens').insert({
    lead_id: lead.id,
    direcao: 'out_humano',
    agente: 'humano',
    agente_origem: 'conversa',
    conteudo,
    whatsapp_message_id: wid || null,
    ...(canal ? { canal_whatsapp: canal, canal_ref: canalRef ?? null } : {}),
  })

  // Dedupe autoritativo: se o wid já existe (índice único uq_mensagens_whatsapp_message_id),
  // é o ECO da própria Sara — o fromMe do WAHA chega tão rápido que corre com a gravação do
  // out_ia, e o SELECT acima pode rodar antes dela commitar. Nesse caso NÃO pausar a IA:
  // tratar como envio nosso já registrado. Sem isto, todo lead recebe a 1ª resposta e a Sara
  // se cala (a própria mensagem dela vira "atendente respondeu manualmente").
  if (erroInsert) {
    if ((erroInsert as { code?: string }).code === '23505') return 'fromMe_sara'
    throw erroInsert
  }

  // A conversa segue no canal por onde a equipe respondeu.
  if (canal && carimbarFamilia) await supabase.from('familias').update({ canal_whatsapp: canal }).eq('id', fam.id)

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
    /** Número físico por onde a mensagem chegou e a resposta sai — liga o portão de envio (src/lib/envio). */
    canalEnvio?: Canal
    /** Conexão no provedor (sessão WAHA, phone_number_id, instância Evolution) — carimbo da mensagem. */
    canalRef?: string | null
    /** Id da mensagem que esta cita (responder no WhatsApp) — usado pelas respostas de Caso. */
    citadoWid?: string | null
    /**
     * Só registra: grava a mensagem e cria um alerta para a equipe responder à mão,
     * sem IA e sem mudar o canal da conversa. Para mensagens de uma conexão pela
     * qual o CRM não responde (ex.: outro chip WAHA) — a resposta automática sairia
     * por outro número.
     */
    somenteRegistrar?: { motivo: string }
  }
): Promise<string> {
  const { telefone, conteudo, pushName, wid, origem, tag, enviarTexto, canal, campanha, referral, phoneNumberId, tipoMidia, urlMidia, canalEnvio, canalRef, citadoWid, somenteRegistrar } = params
  const carimbo: CarimboCanal | null = canalEnvio ? { canal_whatsapp: canalEnvio, canal_ref: canalRef ?? null } : null

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

  // Casa o contato pela IDENTIDADE (número normalizado), não pelo telefone cru:
  // o mesmo número pode chegar como +55…, 55… ou com/sem o 9º dígito. Casar pelo
  // cru fazia o mesmo responsável virar duas famílias/leads.
  const telNorm = normalizarCelular(telefone)

  // CASOS — resposta da equipe pelo WhatsApp, vinda do número de aviso: com código
  // ("#C12 ok ..."), citando o aviso, ou com verbo quando há um único Caso
  // esperando (src/lib/casos/comandos.ts). Sai do fluxo normal: não cria
  // família/lead nem roda IA. O que não for resposta de Caso segue como sempre.
  const cfgCasosEntrada = await lerConfigCasos(supabase)
  if (
    !somenteRegistrar &&
    cfgCasosEntrada.ativo &&
    cfgCasosEntrada.comandosWhatsapp &&
    cfgCasosEntrada.telefoneAviso &&
    normalizarCelular(cfgCasosEntrada.telefoneAviso) === telNorm
  ) {
    const r = await executarRespostaEquipe(supabase, conteudo, citadoWid, wid)
    if (r) {
      if (r.resposta) await enviarTexto(telefone, r.resposta).catch((e) => console.error('[casos] confirmação à equipe falhou:', e))
      if (r.retornoCasoId) await executarRetornoCaso(r.retornoCasoId, supabase)
      return 'comando_caso'
    }
  }

  // Se restar mais de uma família com o mesmo número (duplicata legada), a mais
  // ANTIGA é a canônica — mantém a atribuição first-touch. order+limit evita o
  // erro de "múltiplas linhas" e é determinístico.
  let { data: familia } = await supabase
    .from('familias')
    .select('id, nome_responsavel, ja_responsavel')
    .eq('telefone_norm', telNorm)
    .order('criado_em', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!familia) {
    const ins = await supabase
      .from('familias')
      .insert({
        // Nome de perfil do WhatsApp às vezes é emoji puro ("🌸"); isso não é
        // nome. Guarda o placeholder "Família" e deixa o backfill/extrator pôr
        // o nome real depois. Ver nomePessoaValido em dados-lead.ts.
        nome_responsavel: nomePessoaValido(pushName) ? pushName : 'Família',
        telefone,
        origem,
        canal: canal || 'organico',
        campanha: campanha || null,
        referral: (referral as object | null) ?? null,
        // id do anúncio específico (CTWA sourceID), quando o referral o traz. First-touch,
        // igual a canal/campanha/referral. Usado pelo acompanhamento por anúncio (/anuncios).
        ad_id: (referral as { sourceID?: string } | null)?.sourceID ?? null,
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
        .eq('telefone_norm', telNorm)
        .order('criado_em', { ascending: true })
        .limit(1)
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
  // Canal da conversa = onde o lead acabou de escrever. É o que a política de
  // saída (src/lib/canais) usa para responder, follow-up e envio manual.
  if (canalEnvio && !somenteRegistrar) {
    await supabase.from('familias').update({ canal_whatsapp: canalEnvio }).eq('id', familia.id)
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

    // Mesma corrida do primeiro contato que já tratamos na família: duas mensagens
    // de um número NOVO chegam quase juntas, nenhuma das duas acha lead e as duas
    // tentam inserir. A segunda bate no índice único uniq_lead_ativo_por_familia
    // (um lead ativo por família, 23505) e a mensagem era PERDIDA com "Falha ao
    // criar lead" (ex.: 27/10, 29/10 e 30/10/2026). Reconsulta e grava a mensagem
    // no lead que o vencedor já criou, em vez de falhar.
    if (!lead) {
      const rel = await supabase
        .from('leads')
        .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano, no_show_em, reagendamentos_count')
        .eq('familia_id', familia.id)
        .order('criado_em', { ascending: false })
        .limit(1)
        .maybeSingle()
      lead = rel.data
    }
    if (!lead && ins.error) {
      throw new Error(`Falha ao criar lead: ${ins.error.message}`)
    }
  }
  if (!lead) throw new Error('Falha ao criar lead')

  const { data: msgInserida } = await supabase.from('mensagens').insert({
    lead_id: lead.id,
    direcao: 'in',
    conteudo,
    whatsapp_message_id: wid,
    tipo_midia: tipoMidia || 'texto',
    url_midia: urlMidia || null,
    ...(carimbo ?? {}),
  }).select('id, criado_em').single()
  const msgInId: string | null = msgInserida?.id ?? null
  const msgInCriadoEm: string | null = msgInserida?.criado_em ?? null

  // Lead respondeu: atualiza última interação e reengaja o follow-up (zera contador)
  await supabase
    .from('leads')
    .update({ ultima_interacao_em: new Date().toISOString(), followup_count: 0, followup_sem_resposta: 0, followup_status: 'ativo', precisa_template: false })
    .eq('id', lead.id)

  if (somenteRegistrar) {
    const nome = familia.nome_responsavel || pushName || 'Família'
    await registrarAlerta(
      supabase,
      'conexao-sem-resposta',
      `${nome} (${telefone}) escreveu por ${somenteRegistrar.motivo}. A IA não responde por essa conexão: responda manualmente por ela.\n\n"${conteudo.slice(0, 300)}"`,
      { tipo: 'engajamento', leadId: lead.id },
    )
    return 'registrado_sem_resposta'
  }

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
  // ── ROTEADOR: camada de intenção (src/lib/roteador/turno.ts) ────────────
  // Desligada por padrão (roteador_config.classificador_ligado). Quando ligada, só
  // pode manter o agente da guarda acima ou encaminhar para humano.
  const resolvida = await resolverTurno(supabase, { leadId: lead.id, texto: conteudo, guarda: decisao })
  if (maestroAtivo || resolvida.resultado !== 'guarda') {
    await registrarDecisaoRoteador(supabase, { leadId: lead.id, canal: origem, decisao, resolvida })
  }
  if (resolvida.resultado === 'escalado_humano') {
    await encaminharParaHumano(supabase, {
      leadId: lead.id,
      nomeFamilia: familia.nome_responsavel || 'Família',
      telefone,
      intencao: resolvida.intencao ?? '?',
      confianca: resolvida.confianca,
    })
    return lead.id
  }

  // Opt-out: cliente pediu para parar. Pausa a IA e não responde. A gravação em
  // familias.opt_out_em é best-effort (a coluna pode ainda não existir no banco;
  // o PostgREST só devolve erro no resultado, não derruba o fluxo).
  if (optOut) {
    await supabase.from('familias').update({ opt_out_em: new Date().toISOString() }).eq('id', familia.id)
    await cancelarCasoDoLead(supabase, lead.id, 'opt-out').catch(() => null)
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
  // Portão de envio anti-ban (src/lib/envio): opt-out, janela, repetição, ritmo e
  // contagem no ledger por número. Só quando o webhook informa o canal físico.
  const enviarNoCanal: EnviarTexto = canalEnvio
    ? protegerEnviarTexto(
        { origem: 'resposta_ia', canal: canalEnvio, leadId: lead.id, familiaId: familia.id },
        enviarTexto
      )
    : enviarTexto

  const enviarValidado: EnviarTexto =
    validacaoModo === 'off'
      ? enviarNoCanal
      : async (telefone, texto) => {
          const r = validarResposta(texto)
          if (!r.ok) {
            console.warn(
              `[maestro/validacao modo=${validacaoModo}] vetaria:`,
              r.vetos.map((v) => `${v.codigo}:${v.trecho}`).join(' | ')
            )
          }
          return enviarNoCanal(telefone, texto)
        }
  // O Salomão grava as próprias mensagens: leva o canal junto no envio.
  if (carimbo) enviarValidado.carimbo = carimbo

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
    // Marca o início do turno: se um humano responder pelo celular daqui pra frente
    // (out_humano via ledger), a Sara aborta os balões que ainda faltam enviar (Fase 3).
    const turnoIniciadoEm = new Date().toISOString()
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

      // A Sara SEMPRE responde ao contexto MAIS RECENTE. A chamada ao modelo leva
      // alguns segundos; se a família mandar algo NOVO nesse intervalo, a resposta
      // recém-gerada já nasceu velha (ignorando o que acabou de ser dito) — foi a
      // essência do "respondeu sem ler o contexto" do caso Cris. Como gerarRespostaSara
      // relê o histórico a cada chamada, basta regerar quando aparece um 'in' novo
      // depois do início da geração. Limite de 2 regerações: se a família seguir
      // digitando sem parar, o debounce de 15s da PRÓXIMA execução cobre o resto.
      let antesDaGeracao = new Date().toISOString()
      let saraResult = await gerarRespostaSara(
        lead.id,
        todasColunas as SaraColuna[] | undefined,
        colunaAtual
      )
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        const { data: inboundNovo } = await supabase
          .from('mensagens')
          .select('id')
          .eq('lead_id', lead.id)
          .eq('direcao', 'in')
          .gt('criado_em', antesDaGeracao)
          .limit(1)
          .maybeSingle()
        if (!inboundNovo) break // nada novo chegou durante a geração: a resposta está atual
        antesDaGeracao = new Date().toISOString()
        saraResult = await gerarRespostaSara(
          lead.id,
          todasColunas as SaraColuna[] | undefined,
          colunaAtual
        )
      }

      // GUARDA DE PROMESSA (Casos, modo 'ativo'): prometeu verificar/retornar sem
      // abrir Caso → regera UMA vez pedindo "abra o Caso ou reformule". Se insistir,
      // aplicarCasosDoTurno (mais abaixo) abre um Caso mínimo para a promessa ter dono.
      const cfgCasos = await lerConfigCasos(supabase)
      if (
        cfgCasos.ativo &&
        modoGuarda(cfgCasos.guardaPromessa) === 'ativo' &&
        !saraResult.transbordo &&
        !validarAbertura(saraResult.abrir_caso) &&
        detectaPromessaHumana(saraResult.resposta) &&
        !(await casoAbertoDoLead(supabase, lead.id))
      ) {
        saraResult = await gerarRespostaSara(
          lead.id,
          todasColunas as SaraColuna[] | undefined,
          colunaAtual,
          undefined,
          null,
          { turnoFinal: INSTRUCAO_REFORCO }
        )
      }

      // Envia em balões curtos (uma mensagem por parágrafo), conforme o manual.
      const baloes = dividirEmBaloes(saraResult.resposta)
      for (let i = 0; i < baloes.length; i++) {
        // Humano assumiu no celular durante o turno? Para de enviar (não fala por cima).
        if (await humanoAssumiu(supabase, lead.id, turnoIniciadoEm)) break
        // Assina só o que SAI ("Sara:" em cada balão); grava o texto limpo.
        const sentId = await enviarValidado(telefone, assinar('Sara', baloes[i]))
        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          agente: 'sara',
          agente_origem: 'conversa',
          conteudo: baloes[i],
          whatsapp_message_id: sentId,
          ...(carimbo ?? {}),
        })
        if (i < baloes.length - 1) await sleep(900)
      }

      // Candidato a vaga/currículo: já foi orientado a mandar por e-mail — arquiva e encerra.
      if (saraResult.arquivar) {
        await supabase.from('leads').update({ arquivado: true, ia_ativa: false }).eq('id', lead.id)
        await cancelarCasoDoLead(supabase, lead.id, 'lead arquivado').catch(() => null)
        await supabase.from('acoes_sara').insert({
          lead_id: lead.id,
          tipo: 'movimentacao',
          conteudo: saraResult.motivo_arquivamento || 'Arquivado: candidato a vaga',
          razao: 'candidato_vaga',
          sucesso: true,
        })
        await supabase.from('eventos_timeline').insert({
          lead_id: lead.id,
          tipo: 'movido_coluna',
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

      // REENGAJAMENTO AGENDADO (Repescagem): a família quer decidir mais pra frente e a
      // Sara combinou um mês/período para retomar. Grava a data em `reativar_em` — o lead
      // fica DORMENTE no follow-up (sem cutucada) até lá, quando a Sara manda sozinha um
      // toque de reengajamento (ver src/app/api/cron/followup). Só aceitamos data FUTURA
      // (a Sara é instruída a confirmar o mês antes); data passada/inválida é ignorada.
      const reeng = saraResult.reengajamento
      if (reeng?.reativar_em && /^\d{4}-\d{2}-\d{2}$/.test(reeng.reativar_em)) {
        const [ry, rm, rd] = reeng.reativar_em.split('-').map((n) => parseInt(n, 10))
        // 08:00 na parede de Acre do dia combinado (o cron só envia 8h–20h Acre de todo
        // jeito, então a hora exata é só para a data virar no dia certo, sem erro de fuso).
        const reativarUtc = acreWallToUtc(ry, rm - 1, rd, 8, 0)
        if (!isNaN(reativarUtc.getTime()) && reativarUtc.getTime() > Date.now()) {
          await supabase
            .from('leads')
            .update({
              reativar_em: reativarUtc.toISOString(),
              reativar_motivo: reeng.motivo?.trim() || null,
              // Reinicia o relógio da Repescagem: se o lead já tinha esgotado os toques
              // antes de a família pedir prazo, sem isto o cron o re-esgotaria e o sweep
              // o jogaria em "Perdidos" ignorando a data de reativação. Dormente = limpo.
              followup_count: 0,
              followup_sem_resposta: 0,
              followup_status: 'ativo',
            })
            .eq('id', lead.id)
          await supabase.from('eventos_timeline').insert({
            lead_id: lead.id,
            tipo: 'followup',
            descricao: `Reengajamento agendado: a família quer decidir mais pra frente. A Sara retoma em ${labelAcre(reativarUtc)}${reeng.motivo?.trim() ? ` — ${reeng.motivo.trim()}` : ''}.`,
          })
        }
      }

      // LIGAÇÃO DA DIREÇÃO (26/11/2026): a família cravou dia + hora para a ligação de
      // 15 min. Grava/move a tarefa 'ligacao' (Google Agenda com 15 min) — ver
      // src/lib/ligacao-direcao.ts. Falha aqui nunca derruba o atendimento.
      if (saraResult.agendar_ligacao) {
        try {
          await agendarLigacaoDirecao(supabase, {
            leadId: lead.id,
            nome: familia.nome_responsavel ?? null,
            dataAcre: saraResult.agendar_ligacao.data_acre,
            horaAcre: saraResult.agendar_ligacao.hora_acre,
          })
        } catch (e) {
          console.error('[ligacao-direcao] falha ao agendar', lead.id, e)
          await registrarAlerta(supabase, 'sara/ligacao-direcao', `Falha ao gravar a ligação da Direção: ${e instanceof Error ? e.message : String(e)}`, { leadId: lead.id }).catch(() => {})
        }
      }

      // Dados da família e da criança extraídos pela Sara neste turno. Normaliza
      // os tipos antes de gravar (idade "2 anos" derrubava o insert inteiro) e,
      // se a ficha continuar com buraco, o extrator dedicado completa o que a
      // conversa já respondeu. Ver src/lib/dados-lead.ts.
      try {
        const salvo = await salvarDadosLead(supabase, {
          leadId: lead.id,
          familiaId: familia.id,
          criancaId: lead.crianca_id ?? null,
          familiaDados: saraResult.familia_dados,
          criancaDados: saraResult.crianca_dados,
          sobrescrever: true,
        })
        lead.crianca_id = salvo.criancaId
        await completarDadosLead(supabase, lead.id)
      } catch (e) {
        console.error('[dados-lead] falha ao gravar dados do lead', lead.id, e)
      }

      // Agendamento de visita confirmado pela Sara. TRAVA (2026-09-02): só cria a
      // tarefa/evento na agenda com um horário CONCRETO e FUTURO — a família escolheu
      // uma das opções oferecidas. Interesse vago ou pedido de prazo NÃO agenda.
      let temSlotVisita = false
      // Parte 2 (dizer × fazer): a Sara afirmou no texto que agendou/reagendou?
      // Depois do bloco, se afirmou mas NADA foi gravado, avisamos o gestor.
      // Verbos que significam "eu marquei/mudei o horário" (NÃO inclui "confirmado para",
      // que também é a confirmação de PRESENÇA de uma visita que já existe — evita falso
      // positivo). Exige também um horário no texto.
      // CASO AMANDA (22/11/2026): o regex antigo casava "agenda" (substantivo) numa OFERTA
      // de dois horários e o servidor gravava a visita antes da escolha. Regras em
      // src/lib/agendamento-guarda.ts (testadas).
      // Turno de LIGAÇÃO DA DIREÇÃO: "marquei a ligação para sexta às 10h" não é visita —
      // sem isto a guarda criaria uma visita no slot citado ou alarmaria "dizer × fazer".
      const textoAfirmaAgendamento =
        !saraResult.agendar_ligacao && afirmaAgendamento(saraResult.resposta || '')
      const falaEhOferta = ehOfertaDeHorarios(saraResult.resposta || '')

      let av = saraResult.agendar_visita
      // Fala que OFERECE horários ("24/11 às 09:30 ou 25/11 às 14:00 — qual prefere?")
      // nunca é confirmação, mesmo que o modelo tenha preenchido a ação por engano.
      if (falaEhOferta && av) {
        console.warn('[atendimento] agendar_visita ignorado: a fala é oferta de horários', { lead: lead.id })
        av = null
      }
      // O slot_id é recalculado a cada turno: o modelo pode repetir um id do turno anterior
      // que agora aponta para OUTRO horário. Confere com o horário que ela DISSE.
      if (av?.slot_id) {
        const conferido = conferirSlotComTexto(av.slot_id, saraResult.resposta || '', saraResult.slots_ofertados)
        if (conferido !== av.slot_id) {
          console.warn('[atendimento] slot_id não bate com o horário dito', { lead: lead.id, slot: av.slot_id, conferido })
          av = conferido ? { ...av, slot_id: conferido } : { ...av, slot_id: null }
        }
      }
      // FIX A (2026-11-11): se a Sara AFIRMOU a visita no texto mas não preencheu a ação
      // (o modelo leve falha nisso), casa o dia+hora citados com um slot ofertado neste
      // turno e agenda sozinho — independente de o modelo emitir o JSON. Ver casarSlotAfirmado.
      let agendouPorTexto = false
      if (textoAfirmaAgendamento && !(av && (av.slot_id || av.hora_acre || av.data_hora))) {
        const idCasado = casarSlotGuarda(saraResult.resposta, saraResult.slots_ofertados)
        if (idCasado) {
          av = { slot_id: idCasado, data_hora: null, data_acre: null, hora_acre: null }
          agendouPorTexto = true
        }
      }
      // RAIZ DO FUSO (2026-10-29): o instante vem do SLOT ofertado (servidor), não da
      // hora que o modelo monta. Precedência de resolução:
      //   1) slot_id   → `slots_ofertados` (UTC autoritativo de calcularSlotsDisponiveis);
      //   2) hora_acre → HORA DE PAREDE de Acre via acreWallToUtc (Parte 3: reagendar p/ um
      //      horário DENTRO DA GRADE que a família pediu, sem o bug de fuso); fora da grade
      //      NÃO persiste (a Sara não devia ter confirmado — Parte 1/2 cuidam);
      //   3) data_hora → ISO cru do modelo + clamp antigo (rede de segurança).
      const slotOfertado = av?.slot_id
        ? saraResult.slots_ofertados.find((s) => s.id === av.slot_id)
        : undefined
      if (av && (slotOfertado || av.hora_acre || av.data_hora)) {
        // Grade de visitas (dias/horários em que a escola recebe). Base da validação da
        // Parte 3 e do aviso de "fora da grade".
        const { data: gradeAtiva } = await supabase
          .from('horarios_visita')
          .select('dia_semana, hora_inicio, hora_fim')
          .eq('ativo', true)
        const grade = gradeAtiva && gradeAtiva.length > 0 ? gradeAtiva : null

        // REAGENDAMENTO (2026-09-16): se já existe uma visita futura não concluída,
        // ATUALIZA o horário dela; só insere quando não há nenhuma. Buscada ANTES da
        // resolução porque o reagendamento no mesmo dia por hora_acre usa a data dela.
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

        // Resolve o instante alvo por precedência.
        let dhFinal: Date | null = null
        if (slotOfertado) {
          dhFinal = new Date(slotOfertado.data_hora) // autoritativo, já dentro da grade
        } else if (av.hora_acre && /^\d{1,2}:\d{2}$/.test(av.hora_acre)) {
          // Parte 3: hora de parede de Acre. data_acre explícito, ou a data da visita já
          // marcada (mudança no mesmo dia). acreWallToUtc elimina a ambiguidade de fuso.
          const [hh, mi] = av.hora_acre.split(':').map((n) => parseInt(n, 10))
          const dataAcreOk = av.data_acre && /^\d{4}-\d{2}-\d{2}$/.test(av.data_acre)
          const baseIso = dataAcreOk
            ? `${av.data_acre}T00:00:00Z`
            : visitaAberta
              ? new Date(new Date(visitaAberta.data_hora).getTime() + ACRE_SHIFT_MS).toISOString()
              : null
          if (baseIso) {
            const base = new Date(baseIso) // lê a parede de Acre via getUTC*
            const cand = acreWallToUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mi)
            // Só aceita DENTRO da grade. Fora dela não persiste: a Sara não devia ter
            // confirmado (a Parte 2 avisa o gestor se ela afirmou mesmo assim).
            if (!grade || dentroDaJanelaVisita(cand.toISOString(), grade)) dhFinal = cand
          }
        } else if (av.data_hora) {
          const dh = new Date(av.data_hora)
          if (!isNaN(dh.getTime())) {
            dhFinal = dh
            // Clamp de fuso (2026-10-27): a Sara às vezes carimba a PAREDE como UTC — a
            // visita entra 5h cedo. Se cai FORA da grade mas +5h cai DENTRO, corrige.
            if (grade && !dentroDaJanelaVisita(dh.toISOString(), grade)) {
              const corrigido = new Date(dh.getTime() - ACRE_SHIFT_MS)
              if (dentroDaJanelaVisita(corrigido.toISOString(), grade)) dhFinal = corrigido
            }
          }
        }

        if (dhFinal && !isNaN(dhFinal.getTime()) && dhFinal.getTime() > Date.now()) {
          temSlotVisita = true
          const dhIso = dhFinal.toISOString()
          const mesmoHorario = visitaAberta && new Date(visitaAberta.data_hora).getTime() === dhFinal.getTime()

          if (!mesmoHorario) {
            const reagendou = !!visitaAberta
            if (visitaAberta) {
              // Zera o carimbo do resumo pré-visita: a visita mudou de horário, então o
              // briefing precisa sair de novo ~30 min antes do NOVO horário (ver
              // src/lib/lembrete-visita.ts).
              await supabase
                .from('tarefas')
                .update({ data_hora: dhIso, resumo_pre_visita_em: null, status: 'agendada' })
                .eq('id', visitaAberta.id)
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
              `📅 *Visita ${reagendou ? 'reagendada' : 'agendada'} pela Sara*\nFamília: ${familia.nome_responsavel || 'Família'}\nQuando: ${labelAcre(dhFinal)}`
            )
            // Blindagem de fuso (2026-10-26): mesmo após a correção acima, se o horário
            // AINDA cai FORA da grade de visitas (ex.: a família cravou um horário que a
            // escola não atende), avisamos o gestor — aí não dá para inferir o instante
            // certo sozinho.
            if (grade && !dentroDaJanelaVisita(dhIso, grade)) {
              await notificarGestor(
                supabase,
                'visita',
                `⚠️ *Confira esta visita* — caiu FORA da grade de visitas.\nFamília: ${familia.nome_responsavel || 'Família'}\nHorário gravado: ${labelAcre(dhFinal)} (Acre)\nPode ser erro de fuso da IA. Ajuste o horário na agenda se preciso.`
              )
            }
          }
        }
      }

      // Parte 2 (dizer × fazer): a visita foi REALMENTE gravada/atualizada NESTE turno?
      // (capturado ANTES do fallback abaixo, que marca temSlotVisita por visita ANTIGA).
      const visitaGravadaNoTurno = temSlotVisita

      // FIX A: agendamos pelo texto e o modelo não decidiu a coluna → apontamos a
      // movimentação para "Visita Agendada". A trava `temSlotVisita` no bloco de
      // movimentação abaixo garante que só passa com horário real gravado neste turno.
      // todasColunas já vem filtrada pelo funil do lead (sem ambiguidade de nome).
      if (agendouPorTexto && temSlotVisita && !saraResult.proxima_coluna_id) {
        const colVisita = todasColunas?.find((c) => c.nome === 'Visita Agendada')
        if (colVisita) {
          saraResult.proxima_coluna_id = colVisita.id
          if (!saraResult.razao_movimentacao) {
            saraResult.razao_movimentacao = 'Visita agendada (Sara confirmou o horário na conversa)'
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

      // Parte 2 — REDE DE SEGURANÇA (dizer × fazer): a Sara disse à família que
      // agendou/reagendou um horário, mas NADA foi gravado na agenda neste turno
      // (ela não preencheu agendar_visita, ou o horário caiu fora da grade). Foi o que
      // aconteceu com a Cris (03/11): "já agendei 15:30" sem nunca mexer na tarefa, e a
      // família ficou sem resposta real até o dia seguinte. Avisa o gestor para marcar
      // à mão. NÃO reescreve a fala (a família já recebeu) — só levanta a bandeira.
      // Não alarma se a visita JÁ está na agenda exatamente no dia/hora que ela disse
      // (ex.: só confirmou de novo o horário já gravado).
      let jaEstaNaAgenda = false
      if (textoAfirmaAgendamento && !visitaGravadaNoTurno) {
        const { data: futuras } = await supabase
          .from('tarefas')
          .select('data_hora')
          .eq('lead_id', lead.id)
          .eq('tipo', 'visita')
          .eq('concluida', false)
          .neq('status', 'cancelada')
          .gte('data_hora', new Date().toISOString())
        jaEstaNaAgenda = (futuras ?? []).some((f) => textoCitaInstante(saraResult.resposta || '', f.data_hora))
      }
      if (textoAfirmaAgendamento && !visitaGravadaNoTurno && !jaEstaNaAgenda) {
        await notificarGestor(
          supabase,
          'visita',
          `⚠️ *Confira esta visita* — a Sara disse à família que agendou um horário, mas NÃO entrou na agenda. Confirme com a família e marque à mão.\nFamília: ${familia.nome_responsavel || 'Família'}\nTelefone: ${telefone || '—'}\nO que a Sara disse: "${(saraResult.resposta || '').replace(/\s+/g, ' ').trim().slice(0, 240)}"`
        ).catch((e) => console.error('[atendimento] alerta dizer×fazer falhou:', e))
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
            lead_id: lead.id, tipo: 'movido_coluna',
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

      // Memória durável (src/lib/memoria): fatos que valem além da janela de 20 msgs.
      await aplicarMemoriaDoTurno(supabase, { leadId: lead.id, origem: 'sara', pedidos: saraResult.memoria_salvar })

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

      // Casos: abrir para a equipe / repassar o que a família respondeu / guarda.
      try {
        await aplicarCasosDoTurno(supabase, {
          leadId: lead.id, agente: 'sara', abrirCaso: saraResult.abrir_caso, atualizarCaso: saraResult.atualizar_caso,
          resposta: saraResult.resposta, transbordo: saraResult.transbordo, conteudoIn: conteudo,
        })
      } catch (e) {
        console.error('[casos] Sara: falha ao aplicar Caso:', e)
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
