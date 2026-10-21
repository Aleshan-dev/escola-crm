import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { canalDeSaida, enviarTemplateWhatsApp, enviarTextoWhatsApp, corpoTemplate } from '@/lib/whatsapp-cloud'
import { enviarProtegido } from '@/lib/envio/portao'

// Envia o template aprovado "retomada_lead" para um lead com a janela de 24h fechada.
// Acionado pelo botão "Enviar retomada" no painel de Alertas (usuário logado).
// Sem conta Cloud ativa (número no Evolution/Baileys), não existe janela de 24h:
// envia o mesmo texto como mensagem livre via Evolution.
export async function POST(req: NextRequest) {
  const sb = await createClient()
  const { data: userData } = await sb.auth.getUser()
  if (!userData.user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id } = await req.json().catch(() => ({}))
  if (!lead_id) return NextResponse.json({ error: 'lead_id obrigatório' }, { status: 400 })

  const admin = createServerAdminClient()
  const { data: lead } = await admin
    .from('leads')
    .select('id, familia_id, familia:familias(telefone, nome_responsavel, whatsapp_phone_number_id)')
    .eq('id', lead_id)
    .maybeSingle()
  const fam = (lead as { familia?: { telefone?: string; nome_responsavel?: string; whatsapp_phone_number_id?: string | null } } | null)?.familia
  if (!fam?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })

  try {
    const texto = corpoTemplate('retomada_lead', [fam.nome_responsavel || 'família'])
    const tel = fam.telefone
    // Portão de envio (src/lib/envio): retomada é proativa — opt-out, janela de
    // disparo, teto do dia e ritmo do número valem.
    const r = await enviarProtegido(
      {
        origem: 'reengajar',
        canal: await canalDeSaida(tel, fam.whatsapp_phone_number_id),
        telefone: tel,
        leadId: lead_id,
        familiaId: (lead as { familia_id?: string } | null)?.familia_id ?? null,
      },
      texto,
      async () => {
        try {
          return await enviarTemplateWhatsApp(
            tel,
            'retomada_lead',
            'pt_BR',
            [fam.nome_responsavel || 'família'],
            fam.whatsapp_phone_number_id
          )
        } catch {
          // Sem conta Cloud ativa (ou template indisponível): via Evolution o texto
          // livre entrega a qualquer hora — mesmo conteúdo do template aprovado.
          return await enviarTextoWhatsApp(tel, texto, fam.whatsapp_phone_number_id)
        }
      }
    )
    if (r.status !== 'enviado') {
      return NextResponse.json(
        { ok: false, protecao: r.status, motivo: r.motivo, proxima_tentativa: r.proximaTentativa },
        { status: 409 }
      )
    }
    const wid = r.wid
    await admin.from('mensagens').insert({
      lead_id, direcao: 'out_ia',
      conteudo: texto,
      whatsapp_message_id: wid,
    })
    // Zera a flag e marca o toque (sai da lista de reengajáveis por 2 dias).
    await admin.from('leads').update({ precisa_template: false, ultimo_followup_em: new Date().toISOString() }).eq('id', lead_id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'falha ao enviar template' }, { status: 500 })
  }
}
