import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { salvarMidiaStorage } from '@/lib/midia'
import { enviarMidiaWhatsApp } from '@/lib/whatsapp-cloud'
import { ehErroJanela } from '@/lib/janela'

// Limite prático de tamanho: o corpo de uma função serverless na Vercel é
// limitado (~4,5 MB). Documentos/imagens de matrícula cabem folgado.
const LIMITE_BYTES = 4 * 1024 * 1024 // 4 MB

// Envio de MÍDIA (documento/imagem) pela equipe, a partir do chat.
// Sobe o arquivo ao bucket privado 'midias', despacha pelo WhatsApp (Cloud ou
// Evolution) e grava no histórico como out_humano.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Envio inválido' }, { status: 400 })
  }

  const leadId = String(form.get('lead_id') || '')
  const caption = String(form.get('caption') || '').trim()
  const file = form.get('file')
  if (!leadId) return NextResponse.json({ error: 'lead_id obrigatório' }, { status: 400 })
  if (!(file instanceof File)) return NextResponse.json({ error: 'arquivo obrigatório' }, { status: 400 })
  if (file.size === 0) return NextResponse.json({ error: 'arquivo vazio' }, { status: 400 })
  if (file.size > LIMITE_BYTES) {
    return NextResponse.json({ error: `Arquivo muito grande (máx. ${LIMITE_BYTES / 1024 / 1024} MB).` }, { status: 413 })
  }

  // Telefone + conta (multi-número) do lead
  const { data: lead } = await supabase
    .from('leads')
    .select('familia:familias(telefone, whatsapp_phone_number_id)')
    .eq('id', leadId)
    .single<{ familia: { telefone: string; whatsapp_phone_number_id: string | null } }>()
  if (!lead?.familia?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })

  const mimetype = file.type || 'application/octet-stream'
  const filename = file.name || 'arquivo'
  const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')

  const admin = createServerAdminClient()

  // 1) Persiste no bucket privado (para o histórico do chat)
  const path = await salvarMidiaStorage(admin, { base64, mimetype, filename })
  if (!path) return NextResponse.json({ error: 'Falha ao salvar o arquivo' }, { status: 500 })

  // 2) URL assinada curta — o Evolution baixa e envia por ela
  const { data: signed } = await admin.storage.from('midias').createSignedUrl(path, 300)

  // 3) Despacha pelo WhatsApp (Cloud → id; Evolution → URL assinada)
  let wid: string | null = null
  let tipo: 'imagem' | 'video' | 'audio' | 'documento'
  try {
    const r = await enviarMidiaWhatsApp(lead.familia.telefone, {
      base64, mimetype, filename, caption: caption || undefined, url: signed?.signedUrl,
    }, lead.familia.whatsapp_phone_number_id)
    wid = r.wid
    tipo = r.tipo
  } catch (e) {
    // Fora da janela de 24h (só Cloud): não dá para enviar mídia livre. O arquivo
    // fica salvo; a equipe pode enviar manualmente pelo celular.
    if (ehErroJanela(e)) {
      return NextResponse.json({
        ok: false,
        janela_fechada: true,
        aviso: 'Fora da janela de 24h: envie o arquivo manualmente pelo WhatsApp do celular.',
      })
    }
    const msg = e instanceof Error ? e.message : 'Erro ao enviar'
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  // 4) Grava no histórico
  const { data: nova, error: errMsg } = await admin
    .from('mensagens')
    .insert({
      lead_id: leadId,
      direcao: 'out_humano',
      conteudo: caption || filename,
      tipo_midia: tipo,
      url_midia: path,
      whatsapp_message_id: wid,
    })
    .select('*')
    .single()
  if (errMsg) {
    return NextResponse.json({ error: `Arquivo enviado, mas falhou ao gravar no histórico: ${errMsg.message}` }, { status: 500 })
  }

  return NextResponse.json({ ok: true, mensagem: nova })
}
