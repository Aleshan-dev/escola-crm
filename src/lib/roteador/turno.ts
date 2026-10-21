/**
 * Orquestração do roteador num turno de atendimento (I/O): lê a config e as
 * intenções, monta o contexto, chama o classificador e aplica `resolverRota`.
 * Também executa o efeito do encaminhamento para humano.
 */
import type { createServerAdminClient } from '@/lib/supabase-server'
import type { DecisaoDaPolitica } from '@/lib/maestro/politica'
import { notificarGestor } from '@/lib/notificacoes'
import { classificarIntencao, type Intencao, type MensagemDeContexto } from './classificador'
import { resolverRota, type RotaResolvida } from './resolver'

type SupaAdmin = ReturnType<typeof createServerAdminClient>

export interface ConfigRoteador {
  classificadorLigado: boolean
  credencialId: string | null
  modelo: string | null
  minConfianca: number
  historicoMsgs: number
  intencoes: Intencao[]
}

export const CONFIG_PADRAO: Omit<ConfigRoteador, 'intencoes'> = {
  classificadorLigado: false,
  credencialId: null,
  modelo: null,
  minConfianca: 0.6,
  historicoMsgs: 4,
}

/** Config + intenções ativas. Erro de leitura = classificador desligado (vale a guarda). */
export async function lerConfigRoteador(supabase: SupaAdmin): Promise<ConfigRoteador> {
  try {
    const [{ data: c }, { data: ints }] = await Promise.all([
      supabase.from('roteador_config').select('*').eq('id', 1).maybeSingle(),
      supabase.from('roteador_intencoes').select('nome, descricao, exemplos, agente').eq('ativo', true).order('ordem'),
    ])
    return {
      classificadorLigado: c?.classificador_ligado === true,
      credencialId: c?.credencial_id ?? null,
      modelo: c?.modelo ?? null,
      minConfianca: c?.min_confianca != null ? Number(c.min_confianca) : CONFIG_PADRAO.minConfianca,
      historicoMsgs: c?.historico_msgs ?? CONFIG_PADRAO.historicoMsgs,
      intencoes: (ints ?? []) as Intencao[],
    }
  } catch (e) {
    console.error('[roteador] leitura da config falhou (classificador desligado):', e)
    return { ...CONFIG_PADRAO, intencoes: [] }
  }
}

async function historicoDoLead(supabase: SupaAdmin, leadId: string, n: number): Promise<MensagemDeContexto[]> {
  if (n <= 0) return []
  const { data } = await supabase
    .from('mensagens')
    .select('direcao, conteudo')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(n + 1) // +1: a própria mensagem atual costuma já estar gravada
  return (data ?? [])
    .slice(1)
    .reverse()
    .filter((m: { conteudo: string | null }) => m.conteudo)
    .map((m: { direcao: string; conteudo: string }) => ({ de: m.direcao === 'in' ? 'cliente' : 'escola', texto: m.conteudo }))
}

/**
 * Resolve a rota do turno. Classifica só se o classificador está ligado, há
 * intenções, há texto e a guarda permitiria resposta automática (senão a IA nem
 * responderia — não há o que decidir e não se gasta chamada).
 */
export async function resolverTurno(
  supabase: SupaAdmin,
  args: { leadId: string; texto: string; guarda: DecisaoDaPolitica; config?: ConfigRoteador }
): Promise<RotaResolvida> {
  const cfg = args.config ?? (await lerConfigRoteador(supabase))
  const aplica = cfg.classificadorLigado && cfg.intencoes.length > 0 && args.guarda.permite && args.texto.trim().length > 0
  if (!aplica) return resolverRota(args.guarda, null, cfg.intencoes, cfg.minConfianca)
  const classificacao = await classificarIntencao(supabase, {
    intencoes: cfg.intencoes,
    texto: args.texto,
    historico: await historicoDoLead(supabase, args.leadId, cfg.historicoMsgs),
    credencialId: cfg.credencialId,
    modelo: cfg.modelo,
  })
  return resolverRota(args.guarda, classificacao, cfg.intencoes, cfg.minConfianca)
}

/**
 * Efeito do `escalado_humano`: pausa a IA do lead, marca atendimento humano e avisa
 * o gestor — UMA vez (update condicional: execuções concorrentes da mesma rajada
 * não notificam em dobro). Mesmo efeito do transbordo da Sara (ADR-005).
 */
export async function encaminharParaHumano(
  supabase: SupaAdmin,
  args: { leadId: string; nomeFamilia: string; telefone: string; intencao: string; confianca: number | null }
): Promise<void> {
  const motivo = `Roteador: intenção "${args.intencao}"${args.confianca != null ? ` (${Math.round(args.confianca * 100)}%)` : ''}`
  const { data: flip } = await supabase
    .from('leads')
    .update({ precisa_atendimento_humano: true, ia_ativa: false, motivo_transbordo: motivo, transbordo_em: new Date().toISOString() })
    .eq('id', args.leadId)
    .eq('precisa_atendimento_humano', false)
    .select('id')
  if (!flip || flip.length === 0) return
  await supabase.from('eventos_timeline').insert({
    lead_id: args.leadId,
    tipo: 'status_ia',
    descricao: `IA pausada e conversa encaminhada para atendimento humano. ${motivo}.`,
  })
  await notificarGestor(
    supabase,
    'transbordo',
    `⚠️ *ATENDIMENTO HUMANO NECESSÁRIO*\n\nFamília: ${args.nomeFamilia}\nTelefone: ${args.telefone}\nMotivo: ${motivo}\n\nA IA foi pausada. Acesse o CRM para continuar o atendimento.`
  )
}
