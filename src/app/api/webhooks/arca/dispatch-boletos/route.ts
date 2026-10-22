import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { arcaConfigurado } from '@/lib/arca'
import { evolutionConfigurado } from '@/lib/evolution'
import { convitesConfigurado, drenarConvites } from '@/lib/convites'
import { registrarAlerta } from '@/lib/alertas'

// Gatilho do Arca ("Acionar Salomão"). O Arca monta a fila; ela é entregue pelo
// WhatsApp da escola (mesma instância Evolution da Sara).
//
// DUAS FILAS, UM ENDPOINT (contrato de 29/07/2026). A `salomao-trigger-crm` do
// Arca manda os eventos para o MESMO secret CRM_TRIGGER_URL, então o roteamento
// é pelo campo `event` do corpo, não pelo path:
//   event: "dispatch_boletos"             -> fila boletos_disparo
//   event: "dispatch_mensagens"           -> fila disparos_fila (comunicados)
//   event: "dispatch_convites_matricula"  -> fila matriculas_convites (lib/convites)
// Corpo sem `event` significa boletos: é o que a tela antiga manda, e ela não
// pode quebrar por causa das filas novas.
//
// ANTI-BLOQUEIO (2026-09-03) — MUDANÇA DE ARQUITETURA para boletos e mensagens:
// este endpoint NÃO ENVIA MAIS na hora. Enviar a fila inteira num after() era uma
// RAJADA (até 50 envios em ~1min), o padrão que faz o WhatsApp bloquear o número
// preventivamente — já aconteceu no piloto. Agora o gatilho só CONFIRMA o
// recebimento (a fila já está montada no Arca) e QUEM ENVIA é o cron
// /api/cron/salomao-dispatch: levas pequenas, 15–45s entre contatos, só no
// horário comercial (8h–20h Acre). Ver lib/salomao-dispatch.ts e a
// docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md.
//
// CONVITES seguem enviando em after() aqui: têm claim-lock no Arca
// (convite_reivindicar_lote) e volume pequeno, então não formam rajada.
//
// Falha de CONFIG é reportada de forma síncrona com 5xx (aparece na tela do Arca).

export const maxDuration = 300 // margem para a leva de convites (claim-lock)

const CHAVE = () => process.env.CRM_API_KEY || process.env.SGEI_API_KEY || ''

// Comparação em tempo aproximadamente constante (evita timing attack no segredo).
function chaveConfere(recebida: string | null): boolean {
  const esperada = CHAVE()
  if (!esperada || !recebida) return false
  if (recebida.length !== esperada.length) return false
  let diff = 0
  for (let i = 0; i < esperada.length; i++) diff |= esperada.charCodeAt(i) ^ recebida.charCodeAt(i)
  return diff === 0
}

function autorizado(req: NextRequest): boolean {
  const xApiKey = req.headers.get('x-api-key')
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  return chaveConfere(xApiKey) || chaveConfere(bearer)
}

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook Arca dispatch-boletos online' })
}

export async function POST(req: NextRequest) {
  if (!autorizado(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let corpo: { event?: string } = {}
  try {
    corpo = await req.json()
  } catch {
    /* corpo vazio = boletos (compatibilidade com a tela antiga) */
  }
  const evento = corpo?.event ?? 'dispatch_boletos'

  // O canal de disparos é o gargalo comum aos dois fluxos: sem ele, nada sai.
  if (!(await evolutionConfigurado())) {
    return NextResponse.json({ error: 'evolution_offline' }, { status: 500 })
  }

  // -- fila de convites de pré-matrícula ------------------------------------
  if (evento === 'dispatch_convites_matricula') {
    if (!convitesConfigurado()) {
      // 5xx síncrono: aparece na tela da direção em vez de sumir no background.
      return NextResponse.json({ error: 'sgei_service_key_missing' }, { status: 500 })
    }
    after(async () => {
      const supabase = createServerAdminClient()
      try {
        const r = await drenarConvites()
        if (r.falhas > 0) {
          await registrarAlerta(
            supabase,
            'arca/dispatch-convites',
            `Convites de matrícula: ${r.enviados} enviados, ${r.falhas} falharam (de ${r.reivindicados}). ` +
              `Primeiros erros: ${r.erros.slice(0, 3).join(' | ')}`
          )
        }
      } catch (e) {
        // Falha ao LER a fila: os convites seguem `pendente` e voltam no
        // próximo acionamento ou na varredura de /api/cron/convites.
        await registrarAlerta(
          supabase,
          'arca/dispatch-convites',
          `Falha no disparo de convites: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    })
    return NextResponse.json({ ok: true, aceito: true, fila: 'convites' })
  }

  // -- fila de mensagens em massa (Disparo do Salomão) ----------------------
  // NÃO enviamos aqui (anti-rajada). A fila `disparos_fila` já foi montada no
  // Arca; o cron /api/cron/salomao-dispatch a drena em levas espaçadas, dentro
  // do horário comercial. Só confirmamos o recebimento do gatilho.
  if (evento === 'dispatch_mensagens') {
    if (!arcaConfigurado()) {
      return NextResponse.json({ error: 'crm_api_key_missing' }, { status: 500 })
    }
    return NextResponse.json({
      ok: true, aceito: true, fila: 'mensagens', modo: 'enfileirado',
      entrega: 'O Salomão entrega em levas espaçadas (15–45s entre contatos), das 8h às 20h.',
    })
  }

  // -- fila de boletos ------------------------------------------------------
  // Idem mensagens: não enviamos na hora. A fila `boletos_disparo` é drenada
  // pelo cron /api/cron/salomao-dispatch, sem rajada.
  if (!arcaConfigurado()) {
    return NextResponse.json({ error: 'crm_api_key_missing' }, { status: 500 })
  }
  return NextResponse.json({
    ok: true, aceito: true, fila: 'boletos', modo: 'enfileirado',
    entrega: 'O Salomão entrega em levas espaçadas (15–45s entre contatos), das 8h às 20h.',
  })
}
