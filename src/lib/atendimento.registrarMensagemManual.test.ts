import { describe, it, expect } from 'vitest'
import { registrarMensagemManual } from './atendimento'

// Regressão do bug "a Sara desliga sozinha depois da 1ª mensagem" (28/10/2026):
// o WAHA ecoa a própria resposta da Sara como fromMe=true. Esse eco corre com a
// gravação do out_ia — o SELECT de dedupe roda antes de o out_ia commitar e não
// acha nada. O índice único uq_mensagens_whatsapp_message_id é o dedupe
// AUTORITATIVO: o insert do out_humano bate 23505 → "é eco da própria Sara", não pausa.
//
// ATRIBUIÇÃO POR LEDGER (04/11/2026, caso Cris Ferreira): o sinal primário deixou de
// ser o palpite "lock fresco ⇒ Sara" e passou a ser FATO — o wid está no ledger
// crm.wid_enviado (gravado no envio pelo WAHA)? Sim ⇒ eco nosso (out_ia, não pausa).
// Não ⇒ mensagem digitada no celular por um humano (out_humano + pausa), MESMO com o
// lock fresco. Antes, um humano respondendo pelo aparelho durante o turno da Sara era
// rotulado como Sara e a IA seguia falando por cima. O lock/recência vira só fallback
// para o caso-limite sem wid.

type Resolvido = { data?: unknown; error?: unknown }

function fakeSupabase(cfg: {
  dedupe: Resolvido // mensagens.select do wid -> acha ou não
  ledger?: Resolvido // wid_enviado.select do wid -> nosso envio (tem) ou não
  outIaRecente?: Resolvido // mensagens.select com .gt -> out_ia nos últimos segundos (fallback sem wid)
  insertMensagem: Resolvido // mensagens.insert -> ok ou erro (23505)
  lead: { id: string; ia_ativa: boolean; resposta_lock_em?: string | null }
}) {
  const calls = { pauseUpdate: 0, eventoPausa: 0, insertOutHumano: 0 }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | null = null
    let usouGt = false // só a busca de out_ia recente usa .gt
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.select = () => { op = 'select'; return b }
    b.eq = () => b
    b.gt = () => { usouGt = true; return b }
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
      if (table === 'mensagens' && op === 'select') v = usouGt ? (cfg.outIaRecente ?? { data: null }) : cfg.dedupe
      else if (table === 'wid_enviado' && op === 'select') v = cfg.ledger ?? { data: null }
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
      ledger: { data: null }, // ledger também ainda não tem (corrida extrema) — 23505 é a rede
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

  it('resposta humana real (wid fora do ledger, insert ok) pausa a IA, como manda a ADR-005', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null },
      ledger: { data: null }, // não foi o sistema que enviou
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

  it('eco do balão (wid NO ledger) NÃO pausa, mesmo sem 23505 e com a corrida ganha', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null }, // out_ia deste balão ainda não existe em mensagens
      ledger: { data: { wid: 'true_131533474132178@lid_3EB0' } }, // mas o ENVIO está registrado
      insertMensagem: { error: null }, // o eco GANHOU a corrida: insert do out_ia foi aceito
      lead: { id: 'lead1', ia_ativa: true, resposta_lock_em: new Date().toISOString() },
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999573601',
      conteudo: 'Olá, Cris! Que bom ter você por aqui.',
      wid: 'true_131533474132178@lid_3EB0',
    })

    expect(r).toBe('fromMe_sara')
    expect(calls.insertOutHumano).toBe(1) // gravou (como out_ia), mas…
    expect(calls.pauseUpdate).toBe(0) // …não desligou a Sara
    expect(calls.eventoPausa).toBe(0)
  })

  it('2º balão por caminho SEM trava (ex.: "responder agora"): wid no ledger evita a pausa', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null }, // eco deste balão ainda não gravado como out_ia
      ledger: { data: { wid: 'true_131533474132178@lid_3EB043DD' } }, // envio nosso
      insertMensagem: { error: null }, // o eco ganhou a corrida do insert
      lead: { id: 'lead1', ia_ativa: true, resposta_lock_em: null }, // endpoint não segurou a trava
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999573601',
      conteudo: 'Para sabermos se o valor é referente a este ano ou 2027, qual seria…',
      wid: 'true_131533474132178@lid_3EB043DD',
    })

    expect(r).toBe('fromMe_sara')
    expect(calls.pauseUpdate).toBe(0) // não desligou a Sara
    expect(calls.eventoPausa).toBe(0)
  })

  it('caso Cris: humano digita no celular DURANTE o turno (wid fora do ledger, lock fresco) → pausa', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null }, // wid novo, não está em mensagens
      ledger: { data: null }, // NÃO foi o sistema que enviou → é o humano no aparelho
      insertMensagem: { error: null }, // inseriu como out_humano de verdade
      lead: { id: 'lead1', ia_ativa: true, resposta_lock_em: new Date().toISOString() }, // lock fresco!
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999573601',
      conteudo: 'As 14:30 temos outra visita agendada. Não gostaria de remarcar para amanhã?',
      wid: 'true_131533474132178@lid_2ADA', // assinatura de msg digitada no aparelho
    })

    expect(r).toBe('registrado_out_humano') // antes do fix era 'fromMe_sara' (bug)
    expect(calls.pauseUpdate).toBe(1) // desligou a Sara: o atendente assumiu
    expect(calls.eventoPausa).toBe(1)
  })

  it('fallback SEM wid: lock fresco ainda trata como eco (conservador p/ não calar a Sara)', async () => {
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null },
      insertMensagem: { error: null },
      lead: { id: 'lead1', ia_ativa: true, resposta_lock_em: new Date().toISOString() },
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999573601',
      conteudo: '[mídia sem id]',
      wid: '', // sem wid: não dá para casar no ledger
    })

    expect(r).toBe('fromMe_sara')
    expect(calls.pauseUpdate).toBe(0)
  })

  it('trava de resposta OBSOLETA (>TTL), sem wid e sem out_ia recente: cai na resposta humana', async () => {
    const velho = new Date(Date.now() - 120_000).toISOString() // 2 min > LOCK_TTL_MS (60s)
    const { supabase, calls } = fakeSupabase({
      dedupe: { data: null },
      outIaRecente: { data: null },
      insertMensagem: { error: null }, // humano de verdade
      lead: { id: 'lead1', ia_ativa: true, resposta_lock_em: velho },
    })

    const r = await registrarMensagemManual(supabase, {
      telefone: '5568999573601',
      conteudo: 'Oi, aqui é a secretaria',
      wid: '', // sem wid → fallback por lock/recência
    })

    expect(r).toBe('registrado_out_humano')
    expect(calls.pauseUpdate).toBe(1)
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
