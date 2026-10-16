import { createServerAdminClient } from '@/lib/supabase-server'
import { chamarModeloIA } from '@/lib/ia-credenciais'
import { arcaIdentificar, arcaFinanceiro, arcaRecado, arcaPix, type ArcaFinanceiro, type ArcaPixItem } from '@/lib/arca'
import { notificarGestor } from '@/lib/notificacoes'
import { registrarAlerta } from '@/lib/alertas'
import { sleep } from '@/lib/pacing'
import { normalizarCelularBR } from '@/lib/sgei'
import { DIRETRIZES_MAESTRO } from '@/lib/maestro/diretrizes'

// Salomão — atendente virtual de PAIS JÁ MATRICULADOS (irmão da Sara).
// A Sara atende leads; o Salomão atende famílias matriculadas, sob trava de
// identidade e LGPD. O escola-crm conduz a conversa; o Arca (Edge Function
// salomao-atendimento) decide o que pode ser dito.
//
// Princípio de segurança central: DADOS FINANCEIROS NUNCA SAEM DO LLM.
// O modelo conduz a conversa e extrai intenção + dígitos do CPF; a mensagem
// com títulos/valores é montada por código determinístico a partir da resposta
// do Arca. O 2º fator (3 primeiros dígitos do CPF) é conferido NO BACKEND —
// não dá para contornar pelo lado da conversa.

type SupaAdmin = ReturnType<typeof createServerAdminClient>
type EnviarTexto = (telefone: string, texto: string) => Promise<string | null>

const MAX_TENTATIVAS_CPF = 2

type SalomaoLLM = {
  resposta: string
  acao: 'financeiro' | 'pix' | 'recado' | null
  cpf_prefixo: string | null
  recado_texto: string | null
  transbordo: boolean
  motivo_transbordo: string | null
}

// Quebra em balões curtos por parágrafo (máx. 3) — mesmo padrão do atendimento.
function baloes(texto: string): string[] {
  return texto
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 3)
}

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const dataBR = (iso: string) => {
  const [y, m, d] = (iso || '').slice(0, 10).split('-')
  return y && m && d ? `${d}/${m}/${y}` : iso
}

/** Mensagem financeira 100% determinística — montada da resposta do Arca.
 * Os canais de pagamento vêm de config_ia.salomao_canais_pagamento (editável
 * sem deploy); sem configuração, o fallback aponta para a secretaria. */
export function formatarFinanceiro(fin: ArcaFinanceiro, canaisPagamento?: string | null): string {
  const titulos = fin.titulos || []
  if (titulos.length === 0) {
    return 'Boa notícia: está tudo em dia por aqui — não há nenhuma mensalidade em aberto no momento! 💛\n\nSe precisar de qualquer outra coisa, é só me chamar.'
  }
  const linhas = titulos.map((t) => {
    const vencida = t.status === 'vencida' || new Date(t.vencimento) < new Date()
    return `• ${t.aluno} — ${t.descricao}: ${brl(t.valor)} (vencimento ${dataBR(t.vencimento)}${vencida ? ' — vencida' : ''})`
  })
  const total = typeof fin.total_aberto === 'number' ? fin.total_aberto : titulos.reduce((s, t) => s + t.valor, 0)
  const comoPagar = canaisPagamento?.trim()
    ? `Para pagar: ${canaisPagamento.trim()}`
    : `Para pagar, é só falar com a secretaria da escola.`
  return (
    `Claro! Segue a situação das mensalidades em aberto: 💛\n\n` +
    `${linhas.join('\n')}\n\n` +
    `Total em aberto: ${brl(total)}\n\n` +
    `${comoPagar}\n\nSe tiver qualquer dúvida sobre os valores, ou quiser conversar sobre condições de pagamento, posso deixar um recado para a secretaria falar com você. É só me avisar. 😊`
  )
}

/** Mensagem de PIX 100% determinística — montada da resposta do Arca (nunca via
 * LLM). Cada título vira um bloco com o código Copia e Cola em balão próprio. */
export function formatarPix(pix: ArcaPixItem[]): string {
  if (pix.length === 0) {
    return 'Boa notícia: não há nada em aberto para gerar PIX agora — está tudo em dia! 💛\n\nSe precisar de outra coisa, é só me chamar.'
  }
  const blocos = pix.map(
    (p) => `${p.descricao} — ${brl(p.valor)} (vence ${dataBR(p.vencimento)})\nPIX Copia e Cola:\n${p.copia_cola}`,
  )
  const abertura = 'Claro! Aqui está o PIX Copia e Cola 💛 É só copiar o código e pagar no app do seu banco:'
  const fecho = 'Assim que o pagamento cair, o sistema atualiza sozinho. Qualquer dúvida, me chama! 😊'
  // Um balão de abertura, um por código, um de fecho — o envio quebra por \n\n.
  return `${abertura}\n\n${blocos.join('\n\n')}\n\n${fecho}`
}

async function gerarRespostaSalomaoLLM(
  supabase: SupaAdmin,
  leadId: string,
  primeiroNome: string | undefined,
  cpfTentativas: number
): Promise<SalomaoLLM> {
  const { data: config } = await supabase
    .from('config_ia')
    .select('modelo, salomao_modelo, salomao_system_prompt')
    .eq('id', 1)
    .single()

  const { data: msgs } = await supabase
    .from('mensagens')
    .select('direcao, conteudo')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(20)
  const historico = (msgs || []).reverse()

  const hojeAcre = new Date(Date.now() - 5 * 60 * 60 * 1000).toLocaleDateString('pt-BR', { timeZone: 'UTC' })

  // Preâmbulo de persona (tom/identidade) editável sem deploy via
  // config_ia.salomao_system_prompt. Os blocos de segurança/LGPD/JSON abaixo
  // continuam SEMPRE no código — não são tunáveis pela config, de propósito.
  const preambulo = config?.salomao_system_prompt?.trim() ||
    `Você é Salomão, atendente virtual do Colégio Pequenos Guardiões para FAMÍLIAS JÁ MATRICULADAS.
Tom: cordial, respeitoso, objetivo, acolhedor.`

  const systemPrompt = `${preambulo}${primeiroNome ? ` Trate o responsável pelo primeiro nome: ${primeiroNome}.` : ''}
Hoje é ${hojeAcre} (horário de Rio Branco/Acre).

ESTILO (voz da marca — WhatsApp):
- Frases curtas, calorosas e claras. No máximo 3 balões, cada um com uma única ideia; separe balões com uma linha em branco.
- Vocabulário: família, responsável, mamãe, papai, vocês. NUNCA use "cliente", "usuário", "consumidor".
- Emojis com moderação (💛 😊 🤍) — no máximo um por balão, nunca em mensagem sobre erro/problema sério.
- Tom acolhedor e tranquilizador. Você lida com dinheiro e com a rotina da família: transmita calma e segurança, nunca pressa ou frieza. Nunca soe robótico nem burocrático.

TRANSPARÊNCIA (obrigatório):
- Na sua PRIMEIRA mensagem desta conversa, apresente-se: você é o Salomão, atendente virtual da escola para as famílias matriculadas (ex.: "Oi! Sou o Salomão, atendente virtual do Colégio Pequenos Guardiões 💛").
- NUNCA finja ser humano. Se perguntarem se você é um robô/IA, confirme com naturalidade e diga que a secretaria assume sempre que precisarem.

O QUE VOCÊ FAZ:
1. Informa a situação financeira dos filhos do responsável (mensalidades em aberto, valores, vencimentos) — via ação "financeiro".
2. Envia o PIX Copia e Cola das mensalidades em aberto quando o responsável pede (ex.: "quero o pix", "me manda o código", "2ª via", "como pago", "link de pagamento") — via ação "pix".
3. Registra recados para a secretaria — via ação "recado". Você não resolve sozinho; encaminha para humano.

O QUE VOCÊ NÃO FAZ (NUNCA):
- Não fala de aluno de outra família.
- Não dá baixa em pagamento, não confirma que um PIX foi pago (o sistema confirma sozinho quando cai), não altera cadastro, não promete desconto/negociação — para isso, registre um recado para a secretaria.
- Não inventa NENHUM dado. Você não conhece valores, datas, nomes de alunos nem códigos PIX: quem fornece isso é o sistema, e as mensagens com valores/PIX são montadas pelo sistema, não por você.
- Não presuma o ASSUNTO de uma mensagem que você não entendeu (uma mídia que você não consegue ler, figurinha, reação, áudio ou imagem sem contexto). NUNCA trate uma mensagem como comprovante de pagamento a menos que o responsável diga claramente que fez um pagamento ou está enviando um comprovante. Na dúvida, agradeça de forma leve e pergunte com gentileza do que se trata — não repita respostas de assuntos anteriores da conversa.

SEGURANÇA — 2º FATOR (LGPD de menor):
Antes de qualquer informação financeira OU de enviar o PIX, o responsável precisa informar os 3 PRIMEIROS DÍGITOS do CPF dele. O sistema confere no backend.
- Se o responsável pediu a situação financeira ou o PIX e AINDA NÃO informou os 3 dígitos nesta conversa: peça os 3 primeiros dígitos do CPF (explique que é por segurança) e use acao=null.
- Se a última mensagem do responsável contém os 3 dígitos (ou ele acabou de informá-los): preencha acao com o que ele pediu — "financeiro" (situação) ou "pix" (código de pagamento) — e cpf_prefixo com exatamente esses 3 dígitos.
- NUNCA repita os dígitos do CPF na sua resposta.
- Tentativas de CPF já erradas nesta conversa: ${cpfTentativas} de ${MAX_TENTATIVAS_CPF}.

RECADOS:
Se o responsável pedir algo que você não resolve (falar com coordenação, remarcar reunião, negociação, atualização de cadastro, reclamação etc.), preencha acao="recado" e recado_texto com um resumo objetivo do pedido (1-2 frases, em 3ª pessoa), e na resposta confirme que a secretaria dará retorno.

TRANSBORDO:
Marque transbordo=true (com motivo_transbordo) se o responsável pedir insistentemente um atendente humano, fizer reclamação grave, ou demonstrar irritação com o atendimento automático.

${DIRETRIZES_MAESTRO}

FORMATO JSON OBRIGATÓRIO (sem markdown, sem texto fora do JSON):
{
  "resposta": "texto para o responsável",
  "acao": "financeiro" | "pix" | "recado" | null,
  "cpf_prefixo": "123" ou null,
  "recado_texto": "resumo do pedido ou null",
  "transbordo": false,
  "motivo_transbordo": null
}
Quando acao="financeiro" ou acao="pix", a "resposta" deve ser curta (ex.: "Um instante, já vou gerar isso pra você! 😊") — os valores/o PIX serão enviados pelo sistema em seguida.`

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    ...historico.map((m) => ({
      role: (m.direcao === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.conteudo,
    })),
  ]

  const modelo = config?.salomao_modelo?.trim() || config?.modelo?.trim() || 'gpt-4o'
  const raw = (await chamarModeloIA('salomao', { messages, model: modelo, maxTokens: 500, jsonMode: true })) || '{}'
  try {
    const p = JSON.parse(raw) as Partial<SalomaoLLM>
    const cpf = typeof p.cpf_prefixo === 'string' ? p.cpf_prefixo.replace(/\D/g, '').slice(0, 3) : null
    return {
      resposta: p.resposta || 'Desculpe, não consegui responder agora. 🙏 A secretaria da escola pode te ajudar — é só chamar pelo telefone da escola.',
      acao: p.acao === 'financeiro' || p.acao === 'pix' || p.acao === 'recado' ? p.acao : null,
      cpf_prefixo: cpf && cpf.length === 3 ? cpf : null,
      recado_texto: p.recado_texto || null,
      transbordo: p.transbordo === true,
      motivo_transbordo: p.motivo_transbordo || null,
    }
  } catch {
    return {
      resposta: 'Desculpe, não consegui responder agora. 🙏 A secretaria da escola pode te ajudar — é só chamar pelo telefone da escola.',
      acao: null,
      cpf_prefixo: null,
      recado_texto: null,
      transbordo: false,
      motivo_transbordo: null,
    }
  }
}

async function enviarERegistrar(
  supabase: SupaAdmin,
  leadId: string,
  telefone: string,
  enviarTexto: EnviarTexto,
  texto: string
) {
  const partes = baloes(texto)
  for (let i = 0; i < partes.length; i++) {
    const wid = await enviarTexto(telefone, partes[i])
    await supabase.from('mensagens').insert({
      lead_id: leadId,
      direcao: 'out_ia',
      agente: 'salomao',
      agente_origem: 'conversa',
      conteudo: partes[i],
      whatsapp_message_id: wid,
    })
    if (i < partes.length - 1) await sleep(900)
  }
}

async function ativarTransbordo(
  supabase: SupaAdmin,
  leadId: string,
  motivo: string,
  nomeFamilia: string,
  telefone: string
) {
  await supabase
    .from('leads')
    .update({
      precisa_atendimento_humano: true,
      motivo_transbordo: motivo,
      transbordo_em: new Date().toISOString(),
      ia_ativa: false,
    })
    .eq('id', leadId)

  await supabase.from('eventos_timeline').insert({
    lead_id: leadId,
    tipo: 'status_ia',
    descricao: `Salomão pausado — transbordo: ${motivo}`,
  })

  await notificarGestor(
    supabase,
    'transbordo',
    `⚠️ *SALOMÃO — atendimento humano necessário*\n` +
      `Família (matriculada): ${nomeFamilia}\n` +
      `Telefone: ${telefone}\n` +
      `Motivo: ${motivo}\n\n` +
      `O Salomão foi pausado. Acesse o CRM para continuar o atendimento.`
  )
}

/**
 * Fluxo completo de uma mensagem de responsável MATRICULADO.
 * Chamado por processarMensagemRecebida (atendimento.ts) no lugar da Sara.
 * Envia as respostas, registra em `mensagens` e cuida de transbordo/recado.
 */
export async function processarMensagemSalomao(
  supabase: SupaAdmin,
  params: {
    leadId: string
    telefone: string
    nomeFamilia: string
    conteudoIn: string
    enviarTexto: EnviarTexto
  }
): Promise<void> {
  const { leadId, telefone, nomeFamilia, conteudoIn, enviarTexto } = params

  // Número para o Arca: reconstrói o 9º dígito (gotcha do WhatsApp que entrega o
  // número no formato antigo, sem o 9). O `identificar` do Arca normaliza pelos
  // últimos 11 dígitos e casa com responsaveis.celular_norm — sem reconstruir o 9
  // ele NÃO casa (ex.: "556899545599" -> "56899545599" != "68999545599"). A
  // detecção de entrada do CRM já reconstrói; aqui espelhamos para o Arca.
  // `telefone` cru continua no Evolution (entrega bem mesmo sem o 9).
  const waArca = normalizarCelularBR(telefone) || telefone

  // 1) Identificação no Arca (trava de número único — backend).
  const ident = await arcaIdentificar(waArca)

  if (!ident) {
    // API indisponível: não adivinha nada — encaminha para humano.
    await registrarAlerta(supabase, 'salomao/arca', `identificar falhou para ${telefone} — Arca indisponível`)
    await enviarERegistrar(
      supabase, leadId, telefone, enviarTexto,
      'Puxa, estou com uma instabilidade no sistema neste momento e não consigo consultar agora. 🙏\n\nJá avisei a secretaria e ela vai falar com você em breve, combinado?'
    )
    await ativarTransbordo(supabase, leadId, 'Arca indisponível (salomao-atendimento não respondeu)', nomeFamilia, telefone)
    return
  }

  if (!ident.identificado) {
    // Número desconhecido OU casando com mais de um responsável: nada é revelado.
    await enviarERegistrar(
      supabase, leadId, telefone, enviarTexto,
      'Oi! Aqui é o Salomão, atendente virtual do Colégio Pequenos Guardiões. 💛\n\nPor segurança, não consegui confirmar o seu cadastro por este número. Como aqui a gente trata de dados da sua família, prefiro pedir para a secretaria confirmar tudo com você diretamente.\n\nJá deixei o aviso e ela vai te procurar, combinado?'
    )
    await arcaRecado(waArca, `Número não identificado com match único pediu atendimento. Última mensagem: "${conteudoIn.slice(0, 200)}"`)
    await ativarTransbordo(supabase, leadId, 'Arca não identificou o número com match único', nomeFamilia, telefone)
    return
  }

  // 2) Conversa conduzida pelo LLM.
  const { data: leadRow } = await supabase
    .from('leads')
    .select('salomao_cpf_tentativas')
    .eq('id', leadId)
    .single()
  const tentativas: number = leadRow?.salomao_cpf_tentativas || 0

  const llm = await gerarRespostaSalomaoLLM(supabase, leadId, ident.primeiro_nome, tentativas)

  // 3) Ações decididas pelo LLM, executadas por código.
  if (llm.acao === 'financeiro' && llm.cpf_prefixo) {
    const fin = await arcaFinanceiro(waArca, llm.cpf_prefixo)

    if (fin && fin.confirmado) {
      // CPF conferiu: mensagem financeira 100% determinística (nunca via LLM).
      await supabase.from('leads').update({ salomao_cpf_tentativas: 0 }).eq('id', leadId)
      const { data: cfgPag } = await supabase
        .from('config_ia')
        .select('salomao_canais_pagamento')
        .eq('id', 1)
        .maybeSingle()
      await enviarERegistrar(
        supabase, leadId, telefone, enviarTexto,
        formatarFinanceiro(fin, cfgPag?.salomao_canais_pagamento)
      )
      return
    }

    // CPF não conferiu (ou API falhou) — nada é revelado.
    const novasTentativas = tentativas + 1
    await supabase.from('leads').update({ salomao_cpf_tentativas: novasTentativas }).eq('id', leadId)

    if (!fin) {
      await registrarAlerta(supabase, 'salomao/arca', `financeiro falhou para ${telefone} — Arca indisponível`)
      await enviarERegistrar(
        supabase, leadId, telefone, enviarTexto,
        'Estou com uma instabilidade para consultar o financeiro agora e não quero te passar nenhuma informação errada. 🙏\n\nJá pedi para a secretaria falar com você, combinado?'
      )
      await ativarTransbordo(supabase, leadId, 'Arca indisponível na consulta financeira', nomeFamilia, telefone)
      return
    }

    if (novasTentativas >= MAX_TENTATIVAS_CPF) {
      await enviarERegistrar(
        supabase, leadId, telefone, enviarTexto,
        'Esses dígitos ainda não conferem com o nosso cadastro. 💛\n\nComo são dados da sua família, prefiro não arriscar: vou pedir para a secretaria confirmar isso com você diretamente. Ela já foi avisada, combinado?'
      )
      await arcaRecado(waArca, `Responsável ${ident.primeiro_nome || ''} não passou na confirmação de CPF (${MAX_TENTATIVAS_CPF} tentativas) ao pedir a situação financeira. Secretaria: confirmar identidade e retornar.`)
      await ativarTransbordo(supabase, leadId, `CPF não conferiu ${MAX_TENTATIVAS_CPF}x na consulta financeira`, nomeFamilia, telefone)
      return
    }

    await enviarERegistrar(
      supabase, leadId, telefone, enviarTexto,
      'Hmm, esses três dígitos não bateram com o nosso cadastro. 🤔\n\nPode conferir e me enviar de novo os 3 primeiros números do CPF do responsável, por favor?'
    )
    return
  }

  if (llm.acao === 'pix' && llm.cpf_prefixo) {
    const res = await arcaPix(waArca, llm.cpf_prefixo)

    if (res && res.confirmado) {
      // CPF conferiu: mensagem de PIX 100% determinística (nunca via LLM).
      await supabase.from('leads').update({ salomao_cpf_tentativas: 0 }).eq('id', leadId)
      await enviarERegistrar(supabase, leadId, telefone, enviarTexto, formatarPix(res.pix || []))
      return
    }

    const novasTentativas = tentativas + 1
    await supabase.from('leads').update({ salomao_cpf_tentativas: novasTentativas }).eq('id', leadId)

    if (!res) {
      await registrarAlerta(supabase, 'salomao/arca', `pix falhou para ${telefone} — Arca indisponível`)
      await enviarERegistrar(
        supabase, leadId, telefone, enviarTexto,
        'Estou com uma instabilidade para gerar o PIX agora e não quero te passar nada errado. 🙏\n\nJá pedi para a secretaria falar com você, combinado?'
      )
      await ativarTransbordo(supabase, leadId, 'Arca indisponível na geração de PIX', nomeFamilia, telefone)
      return
    }

    if (novasTentativas >= MAX_TENTATIVAS_CPF) {
      await enviarERegistrar(
        supabase, leadId, telefone, enviarTexto,
        'Esses dígitos ainda não conferem com o nosso cadastro. 💛\n\nComo envolve pagamento, prefiro não arriscar: vou pedir para a secretaria confirmar isso com você diretamente. Ela já foi avisada, combinado?'
      )
      await arcaRecado(waArca, `Responsável ${ident.primeiro_nome || ''} não passou na confirmação de CPF (${MAX_TENTATIVAS_CPF} tentativas) ao pedir o PIX. Secretaria: confirmar identidade e retornar.`)
      await ativarTransbordo(supabase, leadId, `CPF não conferiu ${MAX_TENTATIVAS_CPF}x na geração de PIX`, nomeFamilia, telefone)
      return
    }

    await enviarERegistrar(
      supabase, leadId, telefone, enviarTexto,
      'Hmm, esses três dígitos não bateram com o nosso cadastro. 🤔\n\nPode conferir e me enviar de novo os 3 primeiros números do CPF do responsável, por favor?'
    )
    return
  }

  if (llm.acao === 'recado' && llm.recado_texto) {
    const ok = await arcaRecado(waArca, llm.recado_texto)
    if (ok) {
      await supabase.from('eventos_timeline').insert({
        lead_id: leadId,
        tipo: 'anotacao',
        descricao: `Salomão registrou recado para a secretaria: ${llm.recado_texto}`,
      })
      await notificarGestor(
        supabase,
        'transbordo',
        `📩 *SALOMÃO — recado para a secretaria*\n` +
          `Família (matriculada): ${nomeFamilia}\n` +
          `Telefone: ${telefone}\n` +
          `Recado: ${llm.recado_texto}\n\n` +
          `O recado também está no Arca (atendimento_recados).`
      )
      await enviarERegistrar(supabase, leadId, telefone, enviarTexto, llm.resposta)
    } else {
      await registrarAlerta(supabase, 'salomao/arca', `recado falhou para ${telefone} — Arca indisponível`)
      await enviarERegistrar(
        supabase, leadId, telefone, enviarTexto,
        'Puxa, tive um probleminha para registrar seu recado agora. 🙏\n\nJá avisei a equipe e a secretaria vai falar com você em breve, combinado?'
      )
      await ativarTransbordo(supabase, leadId, 'Falha ao registrar recado no Arca', nomeFamilia, telefone)
    }
    return
  }

  // 4) Resposta conversacional simples (cumprimento, pedir CPF, orientar etc.)
  await enviarERegistrar(supabase, leadId, telefone, enviarTexto, llm.resposta)

  if (llm.transbordo) {
    await ativarTransbordo(
      supabase, leadId,
      llm.motivo_transbordo || 'Solicitado pelo responsável',
      nomeFamilia, telefone
    )
  }
}
