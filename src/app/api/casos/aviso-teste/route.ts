import { NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { lerConfigCasos, textoAviso } from '@/lib/casos/servico'
import { enviarAvisoInterno } from '@/lib/canais/enviar'

// Envia um aviso de Caso de EXEMPLO para o número configurado. É uma mensagem
// REAL (sai pelo WhatsApp da escola). Limite de 3 por hora em memória da
// instância (best-effort; a tela também pede confirmação antes).
export const dynamic = 'force-dynamic'

const envios: number[] = []

export async function POST() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const agora = Date.now()
  while (envios.length && envios[0] < agora - 3_600_000) envios.shift()
  if (envios.length >= 3) return NextResponse.json({ error: 'Limite de 3 testes por hora.' }, { status: 429 })

  const cfg = await lerConfigCasos(createServerAdminClient())
  if (!cfg.telefoneAviso) return NextResponse.json({ error: 'Configure o número de aviso primeiro.' }, { status: 400 })

  const texto = textoAviso(
    {
      numero: 0, agente: 'sara', titulo: 'TESTE — vaga no integral', resumo: 'Exemplo: a mãe quer saber se há vaga no G3 integral à tarde.',
      motivo_bloqueio: 'Mensagem de teste da configuração de Casos.', nota_equipe: null, criado_em: new Date().toISOString(),
    },
    'teste',
    { familia: 'Família de teste', comandos: cfg.comandosWhatsapp }
  )
  try {
    envios.push(agora)
    await enviarAvisoInterno(cfg.telefoneAviso, texto)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Falha no envio' }, { status: 500 })
  }
}
