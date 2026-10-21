/**
 * Classificador de INTENÇÃO do roteador (camada opcional, estilo Deskcomm).
 *
 * Pergunta ao modelo qual das intenções cadastradas descreve a última mensagem do
 * cliente (ou `none`) e com que confiança. As funções de prompt e de leitura da
 * resposta são PURAS e testadas (classificador.test.ts); só `classificarIntencao`
 * faz I/O.
 *
 * A confiança é o número que o próprio modelo devolve — o código valida e limita a
 * 0–1, mas não é uma probabilidade calibrada. O mínimo (padrão 0,6) é uma regra de
 * corte do produto, não uma garantia de 60% de acerto.
 */
import { chamarModeloIA } from '@/lib/ia-credenciais'
import type { createServerAdminClient } from '@/lib/supabase-server'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export interface Intencao {
  nome: string
  descricao: string
  exemplos: string[]
  agente: 'sara' | 'salomao' | 'humano'
}

export interface MensagemDeContexto {
  de: 'cliente' | 'escola'
  texto: string
}

export type Classificacao =
  | { ok: true; intencao: string | null; confianca: number } // intencao null = 'none'
  | { ok: false; erro: string }

export const MODELO_PADRAO = 'gpt-4o-mini'

/** Monta as mensagens do classificador. O histórico serve só para desambiguar ("sim", "a primeira"). */
export function montarPromptClassificador(
  intencoes: Intencao[],
  texto: string,
  historico: MensagemDeContexto[] = []
): { role: 'system' | 'user'; content: string }[] {
  const lista = intencoes
    .map((i) => {
      const ex = i.exemplos.length ? `\n  Exemplos: ${i.exemplos.map((e) => `"${e}"`).join('; ')}` : ''
      return `- ${i.nome}: ${i.descricao}${ex}`
    })
    .join('\n')
  const system =
    'Você classifica a ÚLTIMA mensagem de um cliente de uma escola infantil em UMA das intenções abaixo, ' +
    'ou "none" se nenhuma descreve bem. Não responda ao cliente.\n\n' +
    `Intenções:\n${lista}\n- none: nenhuma das anteriores.\n\n` +
    'Responda SOMENTE JSON: {"intencao": "<nome exato ou none>", "confianca": <0 a 1>}'
  const ctx = historico.length
    ? 'Conversa recente (só para contexto):\n' +
      historico.map((m) => `${m.de === 'cliente' ? 'Cliente' : 'Escola'}: ${m.texto.slice(0, 300)}`).join('\n') +
      '\n\n'
    : ''
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${ctx}Última mensagem do cliente:\n${texto.slice(0, 1500)}` },
  ]
}

/** Lê o JSON do modelo. Recusa intenção que não está cadastrada e JSON inválido; limita a confiança a 0–1. */
export function interpretarClassificacao(bruto: string, nomesValidos: string[]): Classificacao {
  let j: { intencao?: unknown; confianca?: unknown }
  try {
    j = JSON.parse(bruto)
  } catch {
    return { ok: false, erro: 'json_invalido' }
  }
  if (typeof j !== 'object' || j === null || typeof j.intencao !== 'string') return { ok: false, erro: 'json_invalido' }
  const nome = j.intencao.trim()
  const c = Number(j.confianca)
  const confianca = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0
  if (nome === 'none') return { ok: true, intencao: null, confianca }
  if (!nomesValidos.includes(nome)) return { ok: false, erro: 'intencao_desconhecida' }
  return { ok: true, intencao: nome, confianca }
}

/** Chama o modelo e devolve a classificação. Nunca lança: falha vira `{ ok:false }`. */
export async function classificarIntencao(
  supabase: SupaAdmin,
  args: {
    intencoes: Intencao[]
    texto: string
    historico?: MensagemDeContexto[]
    credencialId?: string | null
    modelo?: string | null
  }
): Promise<Classificacao> {
  if (args.intencoes.length === 0) return { ok: false, erro: 'sem_intencoes' }
  try {
    const bruto = await chamarModeloIA(
      'sara',
      {
        messages: montarPromptClassificador(args.intencoes, args.texto, args.historico),
        model: args.modelo?.trim() || MODELO_PADRAO,
        maxTokens: 80,
        jsonMode: true,
        credencialId: args.credencialId ?? null,
      },
      supabase
    )
    return interpretarClassificacao(bruto, args.intencoes.map((i) => i.nome))
  } catch (e) {
    return { ok: false, erro: (e instanceof Error ? e.message : String(e)).slice(0, 120) }
  }
}
