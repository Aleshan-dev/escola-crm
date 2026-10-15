import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'

// Canal "Treinar a Sara": o diretor conversa com a Sara para orientá-la.
// A Sara PLANEJA, PROPÕE e só grava depois do "confirma".
// As mudanças caem em base_conhecimento (fatos/FAQ) e regras_aprendidas
// (comportamento) — as mesmas fontes que já alimentam o prompt da Sara em
// src/lib/sara.ts, então a orientação passa a valer imediatamente.
export const maxDuration = 30

const CATEGORIAS = ['institucional', 'metodologia', 'precos', 'rotinas', 'faq', 'objecoes'] as const

type PlanoConhecimento = { tipo: 'conhecimento'; categoria: string; pergunta: string; resposta: string }
type PlanoRegra = { tipo: 'regra'; texto_regra: string }
type PlanoItem = PlanoConhecimento | PlanoRegra

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}

function normalizarPlano(raw: unknown): PlanoItem[] {
  if (!Array.isArray(raw)) return []
  const out: PlanoItem[] = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (o.tipo === 'conhecimento') {
      const pergunta = typeof o.pergunta === 'string' ? o.pergunta.trim() : ''
      const resposta = typeof o.resposta === 'string' ? o.resposta.trim() : ''
      if (!pergunta || !resposta) continue
      const cat = typeof o.categoria === 'string' && (CATEGORIAS as readonly string[]).includes(o.categoria)
        ? o.categoria
        : 'faq'
      out.push({ tipo: 'conhecimento', categoria: cat, pergunta, resposta })
    } else if (o.tipo === 'regra') {
      const texto = typeof o.texto_regra === 'string' ? o.texto_regra.trim() : ''
      if (!texto) continue
      out.push({ tipo: 'regra', texto_regra: texto })
    }
  }
  return out
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const action = body?.action as string | undefined
  const admin = createServerAdminClient()

  // ── Conversar: interpretar a orientação e PROPOR mudanças ────────────────────
  if (action === 'conversar') {
    const mensagem = typeof body?.mensagem === 'string' ? body.mensagem.trim() : ''
    if (!mensagem) return NextResponse.json({ error: 'mensagem obrigatória' }, { status: 400 })

    const [{ data: config }, { data: kb }, { data: regras }, { data: hist }] = await Promise.all([
      admin.from('config_ia').select('system_prompt, modelo').eq('id', 1).maybeSingle(),
      admin.from('base_conhecimento').select('categoria, pergunta, resposta').eq('ativa', true),
      admin.from('regras_aprendidas').select('texto_regra').eq('ativa', true),
      admin
        .from('sara_treinamento_mensagens')
        .select('papel, conteudo, criado_em')
        .order('criado_em', { ascending: false })
        .limit(20),
    ])

    const historico = (hist || []).reverse()
    const kbAtual = (kb || []).map((k) => `[${k.categoria}] P: ${k.pergunta} | R: ${k.resposta}`).join('\n') || '(vazia)'
    const regrasAtuais = (regras || []).map((r) => `- ${r.texto_regra}`).join('\n') || '(nenhuma)'

    const systemPrompt = `Você é a Sara, a assistente/atendente de matrículas do Colégio Pequenos Guardiões. Neste canal você NÃO fala com famílias: você conversa com a DIREÇÃO da escola, que te orienta e te passa informações — como uma atendente recebendo instruções do diretor.

Seu trabalho: entender a orientação, PLANEJAR e PROPOR como vai incorporá-la, e responder de forma calorosa e profissional confirmando o que entendeu. Você NÃO grava nada agora — o diretor confirma depois.

Classifique o que o diretor disser em zero ou mais itens de plano:
- "conhecimento": um FATO/informação que você deve saber e passar às famílias (preços, rotinas, metodologia, vagas, endereço, políticas, respostas a dúvidas comuns). Gere "categoria" (uma de: ${CATEGORIAS.join(', ')}), "pergunta" (como uma família perguntaria) e "resposta" (o que você responderá).
- "regra": um AJUSTE DE COMPORTAMENTO, tom ou conduta sua no atendimento (ex.: ser mais calorosa, não insistir, sempre oferecer visita). Gere "texto_regra": uma frase imperativa curta e clara.

Uma única mensagem pode gerar vários itens. Regras importantes:
- NUNCA invente dados que o diretor não forneceu.
- NÃO proponha algo que já existe (veja a base e as regras atuais abaixo). Se já existir equivalente, diga isso na resposta e não inclua no plano.
- Se a mensagem for ambígua, ou for só uma pergunta/conversa sem mudança a registrar, retorne "plano": [] e use "resposta" para responder ou pedir o esclarecimento que falta.
- Responda SEMPRE em português.

BASE DE CONHECIMENTO ATUAL (ativa):
${kbAtual}

REGRAS ATUAIS (ativas):
${regrasAtuais}

Responda ESTRITAMENTE em JSON no formato:
{"resposta": "sua fala calorosa para o diretor", "plano": [{"tipo":"conhecimento","categoria":"faq","pergunta":"...","resposta":"..."}, {"tipo":"regra","texto_regra":"..."}]}`

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt },
      ...historico.map((m) => ({
        role: (m.papel === 'diretor' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.conteudo,
      })),
      { role: 'user', content: mensagem },
    ]

    const modelo = config?.modelo?.startsWith('gpt') ? config.modelo : 'gpt-4o'

    let resposta = 'Desculpe, não consegui processar agora.'
    let plano: PlanoItem[] = []
    try {
      const response = await getOpenAI().chat.completions.create({
        model: modelo,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages,
      })
      const parsed = JSON.parse(response.choices[0]?.message?.content || '{}')
      if (typeof parsed.resposta === 'string' && parsed.resposta.trim()) resposta = parsed.resposta.trim()
      plano = normalizarPlano(parsed.plano)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Erro desconhecido'
      return NextResponse.json({ error: `Falha ao gerar resposta: ${msg}` }, { status: 500 })
    }

    const { data: msgDiretor, error: errD } = await admin
      .from('sara_treinamento_mensagens')
      .insert({ papel: 'diretor', conteudo: mensagem, usuario_id: user.id })
      .select('*')
      .single()
    if (errD) return NextResponse.json({ error: errD.message }, { status: 500 })

    const { data: msgSara, error: errS } = await admin
      .from('sara_treinamento_mensagens')
      .insert({
        papel: 'sara',
        conteudo: resposta,
        proposta: plano.length ? plano : null,
        status: plano.length ? 'proposto' : null,
      })
      .select('*')
      .single()
    if (errS) return NextResponse.json({ error: errS.message }, { status: 500 })

    return NextResponse.json({ ok: true, diretor: msgDiretor, sara: msgSara })
  }

  // ── Confirmar: aplicar a proposta nas tabelas que alimentam a Sara ───────────
  if (action === 'confirmar') {
    const mensagemId = body?.mensagem_id as string | undefined
    if (!mensagemId) return NextResponse.json({ error: 'mensagem_id obrigatório' }, { status: 400 })

    const { data: msg } = await admin
      .from('sara_treinamento_mensagens')
      .select('id, proposta, status')
      .eq('id', mensagemId)
      .maybeSingle()
    if (!msg) return NextResponse.json({ error: 'Mensagem não encontrada' }, { status: 404 })
    if (msg.status !== 'proposto') {
      return NextResponse.json({ error: 'Esta proposta já foi confirmada ou descartada.' }, { status: 409 })
    }

    const plano = normalizarPlano(msg.proposta)
    let conhecimentos = 0
    let regrasCriadas = 0

    for (const item of plano) {
      if (item.tipo === 'conhecimento') {
        const { error } = await admin.from('base_conhecimento').insert({
          categoria: item.categoria,
          pergunta: item.pergunta,
          resposta: item.resposta,
          ativa: true,
        })
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        conhecimentos++
      } else {
        const { error } = await admin.from('regras_aprendidas').insert({
          texto_regra: item.texto_regra,
          ativa: true,
          criada_por: 'diretor',
        })
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        regrasCriadas++
      }
    }

    const { data: atualizada } = await admin
      .from('sara_treinamento_mensagens')
      .update({ status: 'confirmado' })
      .eq('id', mensagemId)
      .select('*')
      .single()

    return NextResponse.json({ ok: true, conhecimentos, regras: regrasCriadas, sara: atualizada })
  }

  // ── Descartar: não grava nada ────────────────────────────────────────────────
  if (action === 'descartar') {
    const mensagemId = body?.mensagem_id as string | undefined
    if (!mensagemId) return NextResponse.json({ error: 'mensagem_id obrigatório' }, { status: 400 })

    const { data: atualizada, error } = await admin
      .from('sara_treinamento_mensagens')
      .update({ status: 'descartado' })
      .eq('id', mensagemId)
      .eq('status', 'proposto')
      .select('*')
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, sara: atualizada })
  }

  return NextResponse.json({ error: 'action inválida' }, { status: 400 })
}
