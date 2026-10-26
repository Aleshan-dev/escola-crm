import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { enviarTextoComFallback } from '@/lib/janela'
import { canalDeSaida } from '@/lib/whatsapp-cloud'
import { enviarProtegido } from '@/lib/envio/portao'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id, texto } = await req.json()
  if (!lead_id || !texto) return NextResponse.json({ error: 'lead_id e texto obrigatórios' }, { status: 400 })

  // Pega telefone do lead
  const { data: lead } = await supabase
    .from('leads')
    .select('familia_id, familia:familias(telefone, whatsapp_phone_number_id)')
    .eq('id', lead_id)
    .single<{ familia_id: string; familia: { telefone: string; whatsapp_phone_number_id: string | null } }>()

  if (!lead?.familia?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })

  try {
    // Portão de envio: o envio humano NUNCA é barrado — entra na contagem do número
    // (ledger) e devolve avisos (opt-out, teto do dia) para a tela mostrar.
    const tel = lead.familia.telefone
    const phoneId = lead.familia.whatsapp_phone_number_id
    let r: Awaited<ReturnType<typeof enviarTextoComFallback>> = { enviado: false }
    const JANELA = 'janela_fechada_sem_envio'
    let avisos: string[] = []
    try {
      const canal = await canalDeSaida(tel, phoneId)
      const pr = await enviarProtegido(
        { origem: 'manual', canal, telefone: tel, leadId: lead_id, familiaId: lead.familia_id },
        texto,
        async () => {
          r = await enviarTextoComFallback(tel, texto, { leadId: lead_id, phoneId, familiaId: lead.familia_id, canalEsperado: canal })
          if (!r.enviado) throw new Error(JANELA) // não saiu: o ledger registra 'falhou'
          return r.wid ?? null
        },
      )
      if (pr.status === 'enviado') avisos = pr.avisos
    } catch (e) {
      if (!(e instanceof Error && e.message === JANELA)) throw e
    }

    // Fora da janela de 24h: NÃO foi enviado. Já criamos um alerta (tela Alertas)
    // para envio manual pelo celular. Não gravamos como out_humano — quando a
    // secretária enviar do celular, o echo (smb_message_echoes) registra no chat.
    if (!r.enviado && r.janelaFechada) {
      return NextResponse.json({
        ok: false,
        janela_fechada: true,
        aviso: r.alertaCriado
          ? 'Fora da janela de 24h. Criei um alerta em "Alertas" para envio manual pelo celular.'
          : 'Fora da janela de 24h. Lead inativo (perdido/arquivado) — nenhum alerta criado.',
      })
    }

    // Enviado dentro da janela: grava no histórico.
    // NÃO gravamos enviado_por com o id de auth: a FK aponta para `usuarios`
    // (hoje vazia), então preencher violaria a constraint. A coluna aceita nulo.
    const { error: errMsg } = await supabase.from('mensagens').insert({
      lead_id,
      direcao: 'out_humano',
      conteudo: texto,
      whatsapp_message_id: r.wid,
      ...(r.canal ? { canal_whatsapp: r.canal, canal_ref: r.canalRef ?? null } : {}),
    })
    if (errMsg) {
      // 23505 = unique_violation em whatsapp_message_id: o ECHO desta mesma
      // mensagem (message.any/smb_echo do WhatsApp) chegou primeiro e já gravou.
      // A mensagem foi enviada E está no histórico — sucesso, não erro.
      if (errMsg.code === '23505') {
        return NextResponse.json({ ok: true, jaGravadaPeloEcho: true })
      }
      return NextResponse.json({ error: `Mensagem enviada, mas falhou ao gravar no histórico: ${errMsg.message}` }, { status: 500 })
    }

    return NextResponse.json({ ok: true, ...(avisos.length ? { avisos } : {}) })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
