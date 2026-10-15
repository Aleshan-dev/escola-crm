import { createServerAdminClient } from '@/lib/supabase-server'
import { normalizarCelularBR } from '@/lib/sgei'
import type { ArcaDisparoItem } from '@/lib/arca'

// Registro do boleto disparado no thread do CRM (para aparecer no chat).
// O dispatch envia pelo Evolution; aqui gravamos a mensagem no lead do
// responsável, criando família + lead no funil "Matriculados" se faltar.
//
// Gotcha do 9º dígito: o CRM guarda familias.telefone no formato que o WhatsApp
// entrega — em Acre, quase sempre 12 dígitos SEM o 9 (ex.: 556899545599). O Arca
// manda o E.164 COM o 9 (5568999545599). Para casar com o que o pai usa ao
// responder (e não criar família duplicada), procuramos por sufixo de 8 dígitos
// e, ao criar, gravamos o telefone no formato de 12 dígitos (sem o 9).

type SupaAdmin = ReturnType<typeof createServerAdminClient>

/** E.164/celular -> telefone no formato que o WhatsApp entrega (12 díg., sem o 9). */
// Exportado para o módulo de convites (src/lib/convites.ts) reusar a mesma
// convenção de telefone — duas formas de casar família seriam duas verdades.
export function telefoneFormatoWhatsApp(raw: string): string {
  const recon = normalizarCelularBR(raw) // 11 díg. nacional COM o 9 (DDD+9+8)
  if (recon && recon.length === 11) {
    // "55" + DDD(2) + assinante(8), descartando o 9 reconstruído
    return `55${recon.slice(0, 2)}${recon.slice(3)}`
  }
  return (raw || '').replace(/\D/g, '')
}

/** Localiza a coluna inicial do funil "Matriculados" (para novos leads). */
async function colunaMatriculados(supabase: SupaAdmin): Promise<string | null> {
  const { data: funil } = await supabase
    .from('funis')
    .select('id')
    .ilike('nome', 'matricul%')
    .limit(1)
    .maybeSingle()
  let q = supabase.from('colunas').select('id').order('ordem').limit(1)
  if (funil?.id) q = q.eq('funil_id', funil.id)
  const { data: col } = await q.maybeSingle()
  return col?.id ?? null
}

/**
 * Grava a mensagem do boleto no thread do responsável. Best-effort: nunca lança
 * (o disparo já ocorreu e foi confirmado no Arca). `wid` é o id da mensagem do
 * Evolution — grava-lo faz o echo fromMe deduplicar e NÃO pausar a IA.
 */
export async function registrarBoletoNoChat(
  supabase: SupaAdmin,
  item: ArcaDisparoItem,
  wid: string | null
): Promise<void> {
  try {
    const recon = normalizarCelularBR(item.whatsapp)
    const last8 = (recon || item.whatsapp.replace(/\D/g, '')).slice(-8)
    const telefoneWA = telefoneFormatoWhatsApp(item.whatsapp)

    // 1) Família: casa por sufixo de 8 díg. (invariante ao 9º dígito). Se houver,
    // usa a existente (evita duplicata); senão cria no formato de 12 díg.
    let { data: familia } = await supabase
      .from('familias')
      .select('id')
      .or(`telefone.eq.${telefoneWA},telefone.ilike.*${last8}`)
      .order('ja_responsavel', { ascending: false })
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!familia) {
      const ins = await supabase
        .from('familias')
        .insert({
          nome_responsavel: item.nome_responsavel || 'Família',
          telefone: telefoneWA,
          origem: 'boleto',
          ja_responsavel: true,
        })
        .select('id')
        .single()
      familia = ins.data
    }
    if (!familia) return

    // 2) Lead: usa o mais recente; se não houver, cria no funil Matriculados.
    let { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('familia_id', familia.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!lead) {
      const coluna = await colunaMatriculados(supabase)
      if (!coluna) return
      const ins = await supabase
        .from('leads')
        .insert({ familia_id: familia.id, coluna_id: coluna, ia_ativa: true, tags: ['matriculado'] })
        .select('id')
        .single()
      lead = ins.data
    }
    if (!lead) return

    // 3) Mensagem no thread (idempotente pelo wid). Evita duplicar se já existe.
    if (wid) {
      const { data: ja } = await supabase
        .from('mensagens')
        .select('id')
        .eq('whatsapp_message_id', wid)
        .maybeSingle()
      if (ja) return
    }

    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'out_ia',
      agente: 'salomao',
      agente_origem: 'boleto',
      conteudo: `📎 Boleto enviado — ${item.referencia}\n\n${item.mensagem}`,
      whatsapp_message_id: wid,
      tipo_midia: 'documento',
    })
  } catch (e) {
    console.error('[boletos] registrarBoletoNoChat falhou:', e instanceof Error ? e.message : e)
  }
}
