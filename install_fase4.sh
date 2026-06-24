#!/usr/bin/env bash
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$HOME/escola-crm")"
cd "$REPO_ROOT"

echo "==> Fase 4: Sara IA — Movimentação automática + Follow-up"

# 1. sara.ts
cp src/lib/sara.ts src/lib/sara.ts.bak 2>/dev/null && echo "Backup de sara.ts criado" || true
cat > src/lib/sara.ts << 'SARA_EOF'
import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export type SaraColuna = {
  id: string
  nome: string
  ordem: number
}

export type SaraResposta = {
  resposta: string
  proxima_coluna_id: string | null
  razao_movimentacao: string | null
}

export async function gerarRespostaSara(
  leadId: string,
  colunas?: SaraColuna[],
  colunaAtual?: SaraColuna,
  promptAdicional?: string
): Promise<SaraResposta> {
  const supabase = createServerAdminClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('*, familia:familias(*), crianca:criancas(*)')
    .eq('id', leadId)
    .single()

  if (!lead) throw new Error('Lead não encontrado')

  const { data: config } = await supabase.from('config_ia').select('*').eq('id', 1).single()

  const { data: kb } = await supabase
    .from('base_conhecimento')
    .select('categoria, pergunta, resposta')
    .eq('ativa', true)

  const { data: msgs } = await supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(20)

  const historico = (msgs || []).reverse()

  const instrucaoMovimentacao =
    colunas && colunaAtual
      ? `
MOVIMENTAÇÃO DE FUNIL:
Você pode sugerir mover este lead para a próxima etapa respondendo "proxima_coluna_id".
Coluna atual: "${colunaAtual.nome}" (ordem ${colunaAtual.ordem})
Colunas disponíveis para avanço:
${colunas
  .filter((c) => c.ordem > colunaAtual.ordem)
  .map((c) => `- id="${c.id}" nome="${c.nome}" ordem=${c.ordem}`)
  .join('\n')}

Critérios para avançar coluna (SÓ avance uma etapa por vez, ordem atual + 1):
- Capturados → Em Atendimento: família demonstrou interesse genuíno e está fazendo perguntas concretas
- Em Atendimento → Visita Agendada: combinamos visita com data e horário confirmados
- Visita Agendada → Visita Realizada: família confirmou que a visita aconteceu
- Visita Realizada → Repescagem: família demonstrou dúvida ou pediu prazo
- Qualquer → Perdidos: família disse que não vai matricular (razao_movimentacao é OBRIGATÓRIA)

IMPORTANTE: "Matriculados" requer confirmação humana, NUNCA mova para lá.
Se não houver motivo claro, retorne proxima_coluna_id como null.`
      : ''

  const systemPrompt = `${config?.system_prompt || 'Você é Sara, consultora de matrículas do Colégio Pequenos Guardiões, escola cristã de educação infantil em Fronteiras-PI.'}

INFORMAÇÕES DA ESCOLA (use quando relevante):
${(kb || []).map((k) => `[${k.categoria}] ${k.pergunta}\nResposta: ${k.resposta}`).join('\n\n')}

DADOS QUE JÁ TEM SOBRE ESTA FAMÍLIA:
- Responsável: ${lead.familia?.nome_responsavel || 'não informado'}
- Telefone: ${lead.familia?.telefone}
- Criança: ${lead.crianca?.nome || 'não informado'}${lead.crianca?.idade ? `, ${lead.crianca.idade} anos` : ''}
- Série desejada: ${lead.crianca?.serie_desejada || 'não informado'}
- Período desejado: ${lead.crianca?.periodo || 'não informado'}
- Score atual: ${lead.score}
${instrucaoMovimentacao}
${promptAdicional ? `\nINSTRUÇÃO ESPECIAL: ${promptAdicional}` : ''}

REGRAS:
- Não repita perguntas já respondidas no histórico
- Seja acolhedora, profissional e direta
- Sempre proponha um próximo passo concreto
- Mensagens curtas, no máximo 3 linhas
- Se a família demonstrar interesse forte, ofereça visita presencial

FORMATO DE RESPOSTA OBRIGATÓRIO — responda SOMENTE com JSON válido, sem markdown, sem explicações:
{
  "resposta": "texto da mensagem para a família",
  "proxima_coluna_id": "uuid da próxima coluna OU null",
  "razao_movimentacao": "explicação breve OU null"
}`

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    ...historico.map((m) => ({
      role: (m.direcao === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.conteudo,
    })),
  ]

  const modelo = config?.modelo?.startsWith('gpt') ? config.modelo : 'gpt-4o'

  const response = await openai.chat.completions.create({
    model: modelo,
    max_tokens: 600,
    response_format: { type: 'json_object' },
    messages,
  })

  const raw = response.choices[0]?.message?.content || '{}'

  try {
    const parsed = JSON.parse(raw) as Partial<SaraResposta>
    return {
      resposta: parsed.resposta || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: parsed.proxima_coluna_id ?? null,
      razao_movimentacao: parsed.razao_movimentacao ?? null,
    }
  } catch {
    return {
      resposta: raw || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: null,
      razao_movimentacao: null,
    }
  }
}
SARA_EOF
echo "OK: src/lib/sara.ts"

# 2. webhook/whatsapp/route.ts
cat > src/app/api/webhook/whatsapp/route.ts << 'WEBHOOK_EOF'
import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { cleanWhatsappJid, evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara, SaraColuna } from '@/lib/sara'

export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook escola-crm online' })
}

export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()

  try {
    const body = await req.json()
    const event = body.event
    const data = body.data

    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return NextResponse.json({ ignored: event })
    }

    if (data?.key?.fromMe === true) return NextResponse.json({ ignored: 'fromMe' })

    const jid: string = data?.key?.remoteJid || ''
    if (!jid || jid.includes('@g.us')) return NextResponse.json({ ignored: 'group ou sem jid' })

    const telefone = cleanWhatsappJid(jid)
    const conteudo: string =
      data?.message?.conversation ||
      data?.message?.extendedTextMessage?.text ||
      data?.message?.imageMessage?.caption ||
      '[mídia ou tipo não suportado ainda]'

    const pushName: string = data?.pushName || 'Família'
    const wid: string = data?.key?.id || ''

    // 1. Garante família
    let { data: familia } = await supabase
      .from('familias')
      .select('id, nome_responsavel')
      .eq('telefone', telefone)
      .maybeSingle()

    if (!familia) {
      const ins = await supabase
        .from('familias')
        .insert({ nome_responsavel: pushName, telefone, origem: 'whatsapp' })
        .select('id, nome_responsavel')
        .single()
      familia = ins.data
    }
    if (!familia) throw new Error('Falha ao criar família')

    // 2. Garante lead
    let { data: lead } = await supabase
      .from('leads')
      .select('id, ia_ativa, coluna_id, sara_pode_mover')
      .eq('familia_id', familia.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!lead) {
      const { data: primeiraColuna } = await supabase
        .from('colunas')
        .select('id, ia_ativa_default')
        .order('ordem')
        .limit(1)
        .single()

      const ins = await supabase
        .from('leads')
        .insert({
          familia_id: familia.id,
          coluna_id: primeiraColuna!.id,
          ia_ativa: primeiraColuna!.ia_ativa_default,
          tags: ['whatsapp'],
        })
        .select('id, ia_ativa, coluna_id, sara_pode_mover')
        .single()
      lead = ins.data
    }
    if (!lead) throw new Error('Falha ao criar lead')

    // 3. Salva mensagem recebida
    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'in',
      conteudo,
      whatsapp_message_id: wid,
    })

    // Atualiza ultima_interacao_em
    await supabase
      .from('leads')
      .update({ ultima_interacao_em: new Date().toISOString() })
      .eq('id', lead.id)

    // 4. Sara IA
    if (lead.ia_ativa) {
      try {
        const { data: todasColunas } = await supabase
          .from('colunas')
          .select('id, nome, ordem')
          .order('ordem')

        const colunaAtual = todasColunas?.find((c) => c.id === lead.coluna_id) as
          | SaraColuna
          | undefined

        const saraResult = await gerarRespostaSara(
          lead.id,
          todasColunas as SaraColuna[] | undefined,
          colunaAtual
        )

        const sent = await evolutionSendText(telefone, saraResult.resposta)

        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          conteudo: saraResult.resposta,
          whatsapp_message_id: sent?.key?.id || null,
        })

        // 5. Guard-rails de movimentação
        if (saraResult.proxima_coluna_id && lead.sara_pode_mover !== false && todasColunas && colunaAtual) {
          const proximaColuna = todasColunas.find((c) => c.id === saraResult.proxima_coluna_id)

          let motivoRecusa: string | null = null

          if (!proximaColuna) {
            motivoRecusa = 'coluna_inexistente'
          } else if (proximaColuna.ordem > colunaAtual.ordem + 1) {
            motivoRecusa = `pulou_etapas: tentou ir para ordem ${proximaColuna.ordem} da ordem ${colunaAtual.ordem}`
          } else if (proximaColuna.ordem <= colunaAtual.ordem) {
            motivoRecusa = `regressao: ordem ${proximaColuna.ordem} <= atual ${colunaAtual.ordem}`
          } else if (proximaColuna.nome === 'Matriculados') {
            motivoRecusa = 'matriculados_requer_confirmacao_humana'
          } else if (proximaColuna.nome === 'Perdidos' && !saraResult.razao_movimentacao) {
            motivoRecusa = 'perdidos_sem_razao'
          }

          if (motivoRecusa) {
            await supabase.from('acoes_sara').insert({
              lead_id: lead.id,
              tipo: 'movimentacao',
              conteudo: `Tentativa de mover para "${proximaColuna?.nome}" recusada`,
              razao: motivoRecusa,
              sucesso: false,
              coluna_origem_id: colunaAtual.id,
              coluna_destino_id: saraResult.proxima_coluna_id,
            })
          } else {
            await supabase
              .from('leads')
              .update({
                coluna_id: saraResult.proxima_coluna_id,
                entrou_coluna_em: new Date().toISOString(),
              })
              .eq('id', lead.id)

            await supabase.from('acoes_sara').insert({
              lead_id: lead.id,
              tipo: 'movimentacao',
              conteudo: saraResult.razao_movimentacao || `Movido para ${proximaColuna!.nome}`,
              razao: saraResult.razao_movimentacao,
              sucesso: true,
              coluna_origem_id: colunaAtual.id,
              coluna_destino_id: saraResult.proxima_coluna_id,
            })
          }
        }
      } catch (e) {
        console.error('Sara IA falhou:', e)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('Webhook error:', e)
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
WEBHOOK_EOF
echo "OK: src/app/api/webhook/whatsapp/route.ts"

# 3. cron/followup/route.ts
mkdir -p src/app/api/cron/followup
cat > src/app/api/cron/followup/route.ts << 'CRON_EOF'
import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara } from '@/lib/sara'

const HORA_MIN = 8
const HORA_MAX = 20

function horaAtualSaoPaulo(): number {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hour12: false,
  })
  return parseInt(formatter.format(new Date()), 10)
}

type TriggerNome =
  | 'primeiro_contato_capturados'
  | 'confirmacao_visita_agendada'
  | 'followup_pos_visita'
  | 'recuperacao_repescagem'

type LeadFollowup = {
  id: string
  coluna_id: string
  familia_id: string
  ultima_interacao_em: string | null
  entrou_coluna_em: string | null
  data_proxima_acao: string | null
  ia_ativa: boolean
  familia: { telefone: string; nome_responsavel: string } | null
  coluna: { nome: string; ordem: number } | null
}

async function jaEnviouFollowupRecente(
  supabase: ReturnType<typeof createServerAdminClient>,
  leadId: string,
  trigger: TriggerNome
): Promise<boolean> {
  const limite = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('acoes_sara')
    .select('id')
    .eq('lead_id', leadId)
    .eq('tipo', 'followup')
    .ilike('razao', `followup_${trigger}%`)
    .gte('criado_em', limite)
    .limit(1)
    .maybeSingle()
  return !!data
}

function promptPorTrigger(trigger: TriggerNome, nomeResponsavel: string): string {
  switch (trigger) {
    case 'primeiro_contato_capturados':
      return `Faça o primeiro contato com ${nomeResponsavel}. A família entrou em contato mas ainda não houve atendimento. Apresente-se como Sara, consultora do Colégio Pequenos Guardiões, demonstre acolhimento cristão e pergunte sobre a criança e o que buscam na escola.`
    case 'confirmacao_visita_agendada':
      return `Faça a confirmação da visita agendada para amanhã com ${nomeResponsavel}. Seja calorosa, confirme o endereço e horário, e diga que a escola está esperando com alegria.`
    case 'followup_pos_visita':
      return `Faça um follow-up empático após a visita com ${nomeResponsavel}. Pergunte o que acharam da escola, se a criança gostou, e se têm alguma dúvida antes de tomar a decisão.`
    case 'recuperacao_repescagem':
      return `Faça uma tentativa gentil de recuperação com ${nomeResponsavel}, que está na repescagem há mais de 7 dias. Mostre que há vagas disponíveis, reforce o diferencial cristão da escola e pergunte se houve alguma preocupação que possa ser esclarecida.`
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const vercelCron = req.headers.get('x-vercel-cron')

  const autenticado =
    vercelCron === '1' ||
    (cronSecret && authHeader === `Bearer ${cronSecret}`)

  if (!autenticado) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const hora = horaAtualSaoPaulo()
  if (hora < HORA_MIN || hora >= HORA_MAX) {
    return NextResponse.json({ skipped: `fora_do_horario (${hora}h)` })
  }

  const supabase = createServerAdminClient()
  const agora = new Date()

  const { data: leads, error } = await supabase
    .from('leads')
    .select(`
      id,
      coluna_id,
      familia_id,
      ultima_interacao_em,
      entrou_coluna_em,
      data_proxima_acao,
      ia_ativa,
      familia:familias(telefone, nome_responsavel),
      coluna:colunas(nome, ordem)
    `)
    .eq('ia_ativa', true)

  if (error) {
    console.error('Erro ao buscar leads para followup:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const resultados: {
    leadId: string
    trigger: TriggerNome
    enviado: boolean
    motivo?: string
  }[] = []

  for (const lead of (leads || []) as LeadFollowup[]) {
    if (!lead.familia?.telefone) continue

    const colunaNome = lead.coluna?.nome || ''
    const ultimaInteracao = lead.ultima_interacao_em ? new Date(lead.ultima_interacao_em) : null
    const entrouColuna = lead.entrou_coluna_em ? new Date(lead.entrou_coluna_em) : null

    const interagiu12h =
      ultimaInteracao && agora.getTime() - ultimaInteracao.getTime() < 12 * 60 * 60 * 1000
    if (interagiu12h) continue

    let trigger: TriggerNome | null = null

    if (colunaNome === 'Capturados') {
      const { data: msgsSaida } = await supabase
        .from('mensagens')
        .select('id')
        .eq('lead_id', lead.id)
        .in('direcao', ['out_ia', 'out_humano'])
        .gte('criado_em', new Date(agora.getTime() - 4 * 60 * 60 * 1000).toISOString())
        .limit(1)
        .maybeSingle()

      if (!msgsSaida) {
        trigger = 'primeiro_contato_capturados'
      }
    } else if (colunaNome === 'Visita Agendada' && lead.data_proxima_acao) {
      const dataVisita = new Date(lead.data_proxima_acao)
      const amanha = new Date(agora)
      amanha.setDate(amanha.getDate() + 1)
      if (
        dataVisita.getFullYear() === amanha.getFullYear() &&
        dataVisita.getMonth() === amanha.getMonth() &&
        dataVisita.getDate() === amanha.getDate()
      ) {
        trigger = 'confirmacao_visita_agendada'
      }
    } else if (colunaNome === 'Visita Realizada' && entrouColuna) {
      const horasNaColuna = (agora.getTime() - entrouColuna.getTime()) / (60 * 60 * 1000)
      if (horasNaColuna >= 24) {
        trigger = 'followup_pos_visita'
      }
    } else if (colunaNome === 'Repescagem' && entrouColuna) {
      const diasNaColuna = (agora.getTime() - entrouColuna.getTime()) / (24 * 60 * 60 * 1000)
      if (diasNaColuna >= 7) {
        trigger = 'recuperacao_repescagem'
      }
    }

    if (!trigger) continue

    const jaEnviou = await jaEnviouFollowupRecente(supabase, lead.id, trigger)
    if (jaEnviou) {
      resultados.push({ leadId: lead.id, trigger, enviado: false, motivo: 'ja_enviado_48h' })
      continue
    }

    try {
      const promptAdicional = promptPorTrigger(trigger, lead.familia.nome_responsavel)
      const saraResult = await gerarRespostaSara(lead.id, undefined, undefined, promptAdicional)
      const sent = await evolutionSendText(lead.familia.telefone, saraResult.resposta)

      await supabase.from('mensagens').insert({
        lead_id: lead.id,
        direcao: 'out_ia',
        conteudo: saraResult.resposta,
        whatsapp_message_id: sent?.key?.id || null,
      })

      await supabase
        .from('leads')
        .update({ ultima_interacao_em: new Date().toISOString() })
        .eq('id', lead.id)

      await supabase.from('acoes_sara').insert({
        lead_id: lead.id,
        tipo: 'followup',
        conteudo: saraResult.resposta,
        razao: `followup_${trigger}`,
        sucesso: true,
      })

      resultados.push({ leadId: lead.id, trigger, enviado: true })
    } catch (e) {
      console.error(`Follow-up falhou para lead ${lead.id}:`, e)
      const msg = e instanceof Error ? e.message : 'erro desconhecido'

      await supabase.from('acoes_sara').insert({
        lead_id: lead.id,
        tipo: 'followup',
        conteudo: null,
        razao: `followup_${trigger}`,
        sucesso: false,
      })

      resultados.push({ leadId: lead.id, trigger, enviado: false, motivo: msg })
    }
  }

  return NextResponse.json({
    ok: true,
    hora_sp: hora,
    processados: resultados.length,
    enviados: resultados.filter((r) => r.enviado).length,
    resultados,
  })
}
CRON_EOF
echo "OK: src/app/api/cron/followup/route.ts"

# 4. vercel.json
cat > vercel.json << 'VERCEL_EOF'
{
  "crons": [
    {
      "path": "/api/cron/followup",
      "schedule": "0 * * * *"
    }
  ]
}
VERCEL_EOF
echo "OK: vercel.json"

echo ""
echo "==> Fase 4 instalada com sucesso!"
echo ""
echo "PRÓXIMOS PASSOS:"
echo "1. Adicionar CRON_SECRET em Vercel > Settings > Environment Variables"
echo "2. git add -A && git commit -m 'feat: fase 4 - Sara IA movimentação automática + follow-up'"
echo "3. git push"
echo "4. Aguardar deploy no Vercel"
