import { describe, it, expect } from 'vitest'
import { registrarMensagemManual } from './atendimento'

// Regressão do bug "a Sara desliga sozinha depois da 1ª mensagem" (28/10/2026):
// o WAHA ecoa a própria resposta da Sara como fromMe=true. Esse eco corre com a
// gravação do out_ia — o SELECT de dedupe roda antes de o out_ia commitar e não
// acha nada. O índice único uq_mensagens_whatsapp_message_id é o dedupe
// AUTORITATIVO: o insert do out_humano bate 23505. Antes do fix, o erro era
// ignorado e a IA era pausada ("atendente respondeu manualmente"). Agora o 23505
// significa "é eco da própria Sara" → não pausa.

type Resolvido = { data?: unknown; error?: unknown }

function fakeSupabase(cfg: {
  dedupe: Resolvido // mensagens.select -> acha ou não o wid
  insertMensagem: Resolvido // mensagens.insert -> ok ou erro (23505)
  lead: { id: string; ia_ativa: boolean }
}) {
  const calls = { pauseUpdate: 0, eventoPausa: 0, insertOutHumano: 0 }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | null = null
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.select = () => { op = 'select'; return b }
    b.eq = () => b
    b.order = () => b
    b.limit = () => b
    b.insert = (row?: unknown) => {
      op = 'insert'
      if (table === 'mensagens') calls.insertOutHumano++
      if (table === 'eventos_timeline') calls.eventoPausa++
      void row
      return b
    }
    b.update = () => {
      op = 'update'
      if (table === 'leads') calls.pauseUpdate++
      return b
    }
    b.maybeSingle = () => b
    // thenable: resolve conforme tabela + operação
    b.then = (resolve: (v: Resolvido) => void) => {
      let v: Resolvido = {}
      if (table === 'mensagens' && op === 'select') v = cfg.dedupe
      else if (table === 'mensagens' && op === 'insert') v = cfg.insertMensagem
      else if (table === 'familias' && op === 'select') v = { data: { id: 'fam1' } }
      else if (table === 'leads' && op === 'select') v = { data: cfg.lead }
      resolve(v)
      return undefined
    }
    void chain
    return b
  }

  const supabase = { from: (t: string) => builder(t) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { supabase: supabase as any, calls }
}

describe('registrarMensagemManual — eco fromMe vs resposta humana real', () => {
  it('eco da Sara (wid colide no índice único, 23505) NÃO pausa a IA', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null }, // SELECT correu antes do out_ia commitar
      insertMensagem: { error: { code: '23505' } }, // índice único barrou o duplicado
      lead: { id: 'lead1', ia_ativa: true },
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999491585',
      conteudo: 'Olá! Seja muito bem-vinda…',
      wid: 'true_19933412991108@lid_3EB0',
    })

    expect(r).toBe('fromMe_sara')
    expect(calls.pauseUpdate).toBe(0) // não desligou a Sara
    expect(calls.eventoPausa).toBe(0)
  })

  it('resposta humana real (insert ok) pausa a IA, como manda a ADR-005', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null },
      insertMensagem: { error: null }, // wid novo, inseriu de verdade
      lead: { id: 'lead1', ia_ativa: true },
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999491585',
      conteudo: 'Oi! Aqui é a recepção, pode falar',
      wid: 'true_outro_wid_de_verdade',
    })

    expect(r).toBe('registrado_out_humano')
    expect(calls.pauseUpdate).toBe(1) // desligou a Sara (atendente assumiu)
    expect(calls.eventoPausa).toBe(1)
  })

  it('wid já conhecido no dedupe retorna cedo, sem inserir nem pausar', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: { id: 'msg-existente' } },
      insertMensagem: { error: null },
      lead: { id: 'lead1', ia_ativa: true },
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999491585',
      conteudo: 'qualquer',
      wid: 'wid-ja-gravado',
    })

    expect(r).toBe('fromMe_sara')
    expect(calls.insertOutHumano).toBe(0)
    expect(calls.pauseUpdate).toBe(0)
  })
})
