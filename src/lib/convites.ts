import { createSgeiClient, sgeiConfigurado, normalizarCelularBR } from '@/lib/sgei'
import { createServerAdminClient } from '@/lib/supabase-server'
import { canalNaoOficial, evolutionSendText } from '@/lib/evolution'
import { enviarProtegido, saldoDoDia } from '@/lib/envio/portao'
import { telefoneFormatoWhatsApp } from '@/lib/boletos'
import { jitterMs, sleep } from '@/lib/pacing'

// Convites de pré-matrícula (fila `matriculas_convites` no Arca/sgei).
// Mesmo modelo dos boletos: o Arca NUNCA fala com o Evolution — ele enfileira e
// avisa; o CRM lê a fila e envia, para o Salomão continuar sendo o único
// remetente que as famílias conhecem.
//
// CONTRATO REAL: duas RPCs SECURITY DEFINER no Arca, executáveis por
// service_role (verificado em 29/07/2026). NÃO fazemos UPDATE direto na tabela:
// a máquina de estados é do Arca e ele a defende sozinho.
//
//   convite_reivindicar_lote(p_limite)        -> [{ id, celular, mensagem, lead_id }]
//   convite_marcar_enviado(p_id, p_sucesso, p_erro)
//
// O `reivindicar_lote` faz muito mais do que ler: usa `for update skip locked`,
// marca status='enviando' + reivindicado_em, incrementa `tentativas`, reaver
// itens travados em 'enviando' há mais de 5 min, e já filtra vencido
// (expira_em), esgotado (tentativas >= 3) e mensagem vazia. Ou seja: idempotência,
// exclusão mútua e circuit breaker são do Arca. O CRM só envia e responde.
//
// O `marcar_enviado` só aceita item em 'enviando' (fora disso devolve
// {ignorado:true}) e, na falha, devolve o convite para 'pendente' até a 3ª
// tentativa, virando 'falha' só depois. Portanto NÃO reenfileiramos à mão.
//
// FRONTEIRA: não escrevemos status. Os estados
// aberto/respondido/aprovado/recusado/expirado/cancelado são do Arca.
//
// A `mensagem` vem PRONTA do Arca (com link, prazo e o tom da escola) e é
// enviada exatamente como está. O CRM não monta e não reescreve texto: se
// reescrevesse, a escola perderia o controle do que é dito às famílias.

type SupaAdmin = ReturnType<typeof createServerAdminClient>

/** Teto por leva: 50 × ~1,5s de pacing cabe no maxDuration de 300s com folga. */
export const LIMITE_POR_LEVA = 50

export type ConviteRow = {
  id: string
  celular: string
  mensagem: string | null
  lead_id: string | null
}

export type ResultadoConvites = {
  reivindicados: number
  enviados: number
  falhas: number
  erros: string[]
}

export function convitesConfigurado(): boolean {
  return sgeiConfigurado()
}

/**
 * `(68) 99999-0000` -> `5568999990000` (E.164 sem o '+', como o Evolution espera).
 * Mesmo formato que o Arca já entrega nos boletos, portanto já comprovado em
 * produção. Retorna null em número que não dá para confiar — melhor gravar
 * falha do que disparar o convite de uma família para o número de outra.
 */
export function celularParaEvolution(celular: string): string | null {
  const digitos = (celular || '').replace(/\D/g, '')
  // 10/11 = nacional (com ou sem o 9); 12/13 = já com o código do país.
  if (![10, 11, 12, 13].includes(digitos.length)) return null
  if (digitos.length >= 12 && !digitos.startsWith('55')) return null
  const nacional = normalizarCelularBR(celular)
  if (!nacional || nacional.length !== 11) return null
  return `55${nacional}`
}

/** Reivindica a leva (status -> 'enviando' no Arca). Lança: o chamador reporta. */
async function reivindicarLote(
  sgei: ReturnType<typeof createSgeiClient>,
  limite: number
): Promise<ConviteRow[]> {
  const { data, error } = await sgei.rpc('convite_reivindicar_lote', { p_limite: limite })
  if (error) throw new Error(`convite_reivindicar_lote falhou: ${error.message}`)
  return (data || []) as ConviteRow[]
}

/**
 * Devolve o resultado ao Arca — sempre, sucesso ou falha. Nunca lança: uma
 * confirmação perdida não pode derrubar o resto da leva (o item fica em
 * 'enviando' e o próprio Arca o reaver em 5 min).
 */
async function marcarEnviado(
  sgei: ReturnType<typeof createSgeiClient>,
  id: string,
  sucesso: boolean,
  erro?: string
): Promise<void> {
  try {
    const { error } = await sgei.rpc('convite_marcar_enviado', {
      p_id: id,
      p_sucesso: sucesso,
      p_erro: sucesso ? null : (erro ?? 'erro desconhecido').slice(0, 300),
    })
    if (error) throw new Error(error.message)
  } catch (e) {
    console.error('[convites] marcar_enviado falhou:', e instanceof Error ? e.message : e)
  }
}

/**
 * Registra o convite na thread do CRM — best-effort, nunca lança.
 *
 * Não é cosmético: o convite sai pelo número do Salomão, então o WhatsApp
 * devolve um echo `fromMe` para /api/webhook/whatsapp. Esse handler pausa a
 * Sara ao ver mensagem própria que ele não reconhece (registrarMensagemManual
 * -> ia_ativa = false), assumindo que foi um atendente digitando do celular.
 * Gravar aqui o `whatsapp_message_id` faz o echo cair na dedup por wid
 * ('fromMe_sara') e a Sara NÃO é pausada — justamente na família que está
 * entrando em matrícula.
 *
 * Se não existe família/lead no CRM para o número, não criamos nada: um convite
 * de PRÉ-matrícula não pertence ao funil "Matriculados", e o echo de um número
 * desconhecido já termina em 'fromMe_sem_familia' sem pausar ninguém.
 */
async function registrarConviteNoChat(
  supabase: SupaAdmin,
  it: ConviteRow,
  wid: string | null
): Promise<void> {
  try {
    if (!wid) return
    const nacional = normalizarCelularBR(it.celular)
    if (!nacional) return
    const last8 = nacional.slice(-8)
    const telefoneWA = telefoneFormatoWhatsApp(it.celular)

    // Casa por sufixo de 8 dígitos: invariante ao 9º dígito, que no Acre o
    // WhatsApp costuma entregar sem (ver comentário em boletos.ts).
    const { data: familia } = await supabase
      .from('familias')
      .select('id')
      .or(`telefone.eq.${telefoneWA},telefone.ilike.*${last8}`)
      .order('ja_responsavel', { ascending: false })
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!familia) return

    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('familia_id', familia.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!lead) return

    const { data: ja } = await supabase
      .from('mensagens')
      .select('id')
      .eq('whatsapp_message_id', wid)
      .maybeSingle()
    if (ja) return

    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'out_ia',
      conteudo: `📝 Convite de pré-matrícula enviado\n\n${it.mensagem ?? ''}`,
      whatsapp_message_id: wid,
      canal_whatsapp: canalNaoOficial(), // campanha: sai pelo canal de disparos
    })
  } catch (e) {
    console.error('[convites] registrarConviteNoChat falhou:', e instanceof Error ? e.message : e)
  }
}

/**
 * Drena a fila de convites: reivindica -> envia -> devolve o resultado.
 *
 * O write-back não é opcional: a tela da direção mostra este estado. Sem ele, a
 * direção vê "Na fila do Salomão" para sempre e não sabe se a família recebeu.
 *
 * Uma falha por item nunca derruba os outros itens da mesma leva. Falha ao
 * reivindicar a leva lança, para o chamador registrar alerta.
 */
export async function drenarConvites(limite = LIMITE_POR_LEVA): Promise<ResultadoConvites> {
  const sgei = createSgeiClient()
  const supabase = createServerAdminClient()
  const out: ResultadoConvites = { reivindicados: 0, enviados: 0, falhas: 0, erros: [] }

  // Portão de envio: dimensiona a leva pelo saldo do dia do número ANTES de
  // reivindicar — item devolvido ao Arca queima uma tentativa dele.
  const canal = canalNaoOficial()
  const saldo = await saldoDoDia(canal)
  if (saldo === 0) return out
  const items = await reivindicarLote(sgei, saldo == null ? limite : Math.min(limite, saldo))
  out.reivindicados = items.length
  if (items.length === 0) return out

  for (let i = 0; i < items.length; i++) {
    const it = items[i]

    // O Arca já garante mensagem não vazia (CHECK + filtro da RPC). Guarda
    // defensiva: WhatsApp em branco para a família é pior que uma falha.
    const texto = (it.mensagem ?? '').trim()
    if (!texto) {
      out.falhas++
      out.erros.push(`${it.id}: mensagem vazia`)
      await marcarEnviado(sgei, it.id, false, 'convite sem mensagem ao chegar no CRM')
      continue
    }

    // Normalização do número é do lado do CRM: o Arca entrega mascarado
    // ("(68) 99999-9999"), o Evolution quer E.164.
    const numero = celularParaEvolution(it.celular)
    if (!numero) {
      out.falhas++
      out.erros.push(`${it.id}: celular inválido`)
      await marcarEnviado(sgei, it.id, false, `celular inválido para envio: "${it.celular}"`)
      continue
    }

    try {
      const r = await enviarProtegido(
        { origem: 'convite', canal, telefone: numero, leadId: it.lead_id ?? null },
        texto,
        async () => (await evolutionSendText(numero, texto))?.key?.id ?? null,
      )
      if (r.status !== 'enviado') {
        // Raro (o saldo já foi checado): devolve ao Arca, que decide o retry.
        out.falhas++
        out.erros.push(`${it.id}: ${r.status} pelo portão (${r.motivo})`)
        await marcarEnviado(sgei, it.id, false, `${r.status} pela proteção de envio do CRM: ${r.motivo}`)
        if (r.status === 'adiado') break
        continue
      }
      await marcarEnviado(sgei, it.id, true)
      out.enviados++
      await registrarConviteNoChat(supabase, it, r.wid)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      out.falhas++
      out.erros.push(`${it.id}: ${msg.slice(0, 120)}`)
      // O Arca decide se isto volta para 'pendente' (retry) ou vira 'falha'.
      await marcarEnviado(sgei, it.id, false, msg)
    }

    // Pacing anti-bloqueio: espaça os envios (menos no último).
    // Ver docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md.
    if (i < items.length - 1) await sleep(jitterMs(1000, 2000))
  }

  return out
}
