#!/usr/bin/env bash
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$HOME/escola-crm")"
cd "$REPO_ROOT"

echo "==> Bugfix: Sara IA — anti-alucinação + criancas + transbordo"

# Backup
cp src/lib/sara.ts src/lib/sara.ts.bak 2>/dev/null && echo "Backup sara.ts criado" || true
cp src/app/api/webhook/whatsapp/route.ts src/app/api/webhook/whatsapp/route.ts.bak 2>/dev/null && echo "Backup webhook criado" || true

# 1. sara.ts
cat > src/lib/sara.ts << 'SARA_EOF'
import OpenAI from 'openai'
import { createServerAdminClient } from '@/lib/supabase-server'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export type SaraColuna = {
  id: string
  nome: string
  ordem: number
}

export type SaraFamiliaDados = {
  nome_responsavel?: string
  email?: string
  cep?: string
  rua?: string
  numero?: string
  bairro?: string
  cidade?: string
  estado?: string
}

export type SaraCriancaDados = {
  nome?: string
  idade?: number
  data_nascimento?: string
  serie_desejada?: string
  periodo?: string
}

export type SaraResposta = {
  resposta: string
  proxima_coluna_id: string | null
  razao_movimentacao: string | null
  familia_dados: SaraFamiliaDados | null
  crianca_dados: SaraCriancaDados | null
  transbordo: boolean
  motivo_transbordo: string | null
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

  const ultimasMsgsIA = historico
    .filter((m) => m.direcao === 'out_ia')
    .slice(-3)
    .map((m) => m.conteudo.toLowerCase())
  const countVerificar = ultimasMsgsIA.filter(
    (t) => t.includes('vou verificar') || t.includes('vou checar') || t.includes('equipe')
  ).length

  const instrucaoMovimentacao =
    colunas && colunaAtual
      ? `
MOVIMENTAÇÃO DE FUNIL:
Coluna atual: "${colunaAtual.nome}" (ordem ${colunaAtual.ordem})
Próximas opções:
${colunas
  .filter((c) => c.ordem > colunaAtual.ordem)
  .map((c) => `- id="${c.id}" nome="${c.nome}" ordem=${c.ordem}`)
  .join('\n')}
Critérios (só avance UMA etapa, ordem atual+1):
- Capturados→Em Atendimento: família fez pergunta concreta ou demonstrou interesse real
- Em Atendimento→Visita Agendada: visita confirmada com data/hora
- Visita Agendada→Visita Realizada: família confirmou que a visita ocorreu
- Visita Realizada→Repescagem: família pediu prazo ou demonstrou dúvida
- Qualquer→Perdidos: família recusou explicitamente (razao_movimentacao obrigatória)
"Matriculados" NUNCA pode ser destino.`
      : ''

  const baseKnowledge = (kb || [])
    .map((k) => `[${k.categoria}] P: ${k.pergunta}\nR: ${k.resposta}`)
    .join('\n\n')

  const dadosFamilia = lead.familia
  const dadosCrianca = lead.crianca

  const systemPrompt = `${config?.system_prompt || 'Você é Sara, consultora de matrículas do Colégio Pequenos Guardiões.'}

════════════════════════════════
BASE DE CONHECIMENTO OFICIAL DA ESCOLA
(USE APENAS ESTAS INFORMAÇÕES. NUNCA INVENTE DADOS NÃO LISTADOS ABAIXO.)
════════════════════════════════
${baseKnowledge}

════════════════════════════════
REGRA ANTI-ALUCINAÇÃO — CRÍTICA
════════════════════════════════
- Se a pergunta NÃO puder ser respondida com os dados acima: diga "Vou verificar essa informação com a equipe e te retorno em breve! 😊"
- NUNCA invente endereço, telefone, valor, nome de professora ou qualquer dado não listado.
- O endereço correto é: Rua Avestruz, nº 271, Bairro Nova Esperança, Rio Branco – Acre.

════════════════════════════════
DADOS JÁ COLETADOS DESTA FAMÍLIA
════════════════════════════════
- Responsável: ${dadosFamilia?.nome_responsavel || 'não informado'}
- Criança: ${dadosCrianca?.nome || 'não informado'}
- Idade: ${dadosCrianca?.idade ? `${dadosCrianca.idade} anos` : 'não informado'}
- Série desejada: ${dadosCrianca?.serie_desejada || 'não informado'}
- Período desejado: ${dadosCrianca?.periodo || 'não informado'}

DADOS OBRIGATÓRIOS FALTANDO (colete um por vez):
${!dadosCrianca?.nome ? '- Nome da criança\n' : ''}${!dadosCrianca?.idade ? '- Idade da criança\n' : ''}${!dadosCrianca?.serie_desejada ? '- Série/turma desejada\n' : ''}${!dadosCrianca?.periodo ? '- Período desejado\n' : ''}
${instrucaoMovimentacao}
${promptAdicional ? `\nINSTRUÇÃO ESPECIAL: ${promptAdicional}` : ''}

════════════════════════════════
TRANSBORDO PARA HUMANO
════════════════════════════════
Marque transbordo=true se:
1. Família pediu para falar com atendente/humano/coordenação
2. Família fez reclamação grave
3. Você usou "vou verificar com a equipe" 2+ vezes seguidas
Gatilho automático: ${countVerificar >= 2 ? 'SIM — FORCE transbordo=true agora.' : 'não ativo'}

════════════════════════════════
FORMATO JSON OBRIGATÓRIO (sem markdown, sem texto fora do JSON)
════════════════════════════════
{
  "resposta": "texto para a família",
  "proxima_coluna_id": "uuid ou null",
  "razao_movimentacao": "texto ou null",
  "familia_dados": { "nome_responsavel": "...", "email": "..." } ou null,
  "crianca_dados": { "nome": "...", "idade": 3, "serie_desejada": "G3", "periodo": "integral" } ou null,
  "transbordo": false,
  "motivo_transbordo": "texto ou null"
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
    max_tokens: 700,
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
      familia_dados: parsed.familia_dados ?? null,
      crianca_dados: parsed.crianca_dados ?? null,
      transbordo: parsed.transbordo === true,
      motivo_transbordo: parsed.motivo_transbordo ?? null,
    }
  } catch {
    return {
      resposta: raw || 'Desculpe, não consegui responder agora.',
      proxima_coluna_id: null,
      razao_movimentacao: null,
      familia_dados: null,
      crianca_dados: null,
      transbordo: false,
      motivo_transbordo: null,
    }
  }
}
SARA_EOF
echo "OK: src/lib/sara.ts"

# 2. webhook
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

    let { data: lead } = await supabase
      .from('leads')
      .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano')
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
        .select('id, ia_ativa, coluna_id, sara_pode_mover, crianca_id, precisa_atendimento_humano')
        .single()
      lead = ins.data
    }
    if (!lead) throw new Error('Falha ao criar lead')

    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'in',
      conteudo,
      whatsapp_message_id: wid,
    })

    await supabase
      .from('leads')
      .update({ ultima_interacao_em: new Date().toISOString() })
      .eq('id', lead.id)

    if (lead.ia_ativa && !lead.precisa_atendimento_humano) {
      try {
        const { data: todasColunas } = await supabase
          .from('colunas')
          .select('id, nome, ordem')
          .order('ordem')

        const colunaAtual = todasColunas?.find((c) => c.id === lead.coluna_id) as SaraColuna | undefined

        const saraResult = await gerarRespostaSara(lead.id, todasColunas as SaraColuna[] | undefined, colunaAtual)

        const sent = await evolutionSendText(telefone, saraResult.resposta)

        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          conteudo: saraResult.resposta,
          whatsapp_message_id: sent?.key?.id || null,
        })

        // Salva dados da família extraídos
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

        // Salva/atualiza criança
        if (saraResult.crianca_dados) {
          const cd = saraResult.crianca_dados
          if (cd.nome || cd.idade || cd.serie_desejada || cd.periodo) {
            if (lead.crianca_id) {
              const update: Record<string, string | number> = {}
              if (cd.nome) update.nome = cd.nome
              if (cd.idade) update.idade = cd.idade
              if (cd.data_nascimento) update.data_nascimento = cd.data_nascimento
              if (cd.serie_desejada) update.serie_desejada = cd.serie_desejada
              if (cd.periodo) update.periodo = cd.periodo
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
                })
                .select('id')
                .single()

              if (novaCrianca) {
                await supabase.from('leads').update({ crianca_id: novaCrianca.id }).eq('id', lead.id)
              }
            }
          }
        }

        // Guard-rails movimentação
        if (saraResult.proxima_coluna_id && lead.sara_pode_mover !== false && todasColunas && colunaAtual) {
          const proximaColuna = todasColunas.find((c) => c.id === saraResult.proxima_coluna_id)
          let motivoRecusa: string | null = null

          if (!proximaColuna) motivoRecusa = 'coluna_inexistente'
          else if (proximaColuna.ordem > colunaAtual.ordem + 1) motivoRecusa = `pulou_etapas`
          else if (proximaColuna.ordem <= colunaAtual.ordem) motivoRecusa = `regressao`
          else if (proximaColuna.nome === 'Matriculados') motivoRecusa = 'matriculados_requer_confirmacao_humana'
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
            }).catch(() => {})
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

            await evolutionSendText(telTransbordo, msg).catch((e) =>
              console.error('Falha ao notificar transbordo:', e)
            )
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

echo ""
echo "==> Bugfixes instalados!"
echo ""
echo "PRÓXIMOS PASSOS:"
echo "2. git add -A && git commit -m 'fix: Sara anti-alucinacao, criancas e transbordo'"
echo "3. git push"
