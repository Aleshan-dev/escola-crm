/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, Sparkles, ThumbsUp, ThumbsDown, ShieldCheck } from 'lucide-react'

// ADR-006 Nível 1: revisão humana das sugestões do Auditor Cognitivo.
// Aplicar = confirmo o diagnóstico (conta para a recorrência de Nível 2).
// Rejeitar = descarto. Regras candidatas: critérios cujo gap se repete.

const REGRA_MIN = 3 // ocorrências validadas p/ virar candidata a regra (Nível 2)

const CRITERIO_LABEL: Record<string, string> = {
  conexao_inicial: 'Conexão inicial',
  qualificacao: 'Qualificação',
  diagnostico: 'Diagnóstico',
  construcao_valor: 'Construção de valor',
  convite: 'Convite',
  clareza: 'Clareza',
  continuidade: 'Continuidade',
  fluencia: 'Fluência',
  confianca: 'Confiança',
  objecao_preco: 'Objeção de preço',
  reagendamento: 'Reagendamento',
  fechamento: 'Fechamento',
  confirmacao: 'Confirmação',
  reativacao: 'Reativação',
  diagnostico_perda: 'Diagnóstico da perda',
  nenhum: 'Sem gap',
}

function faixaBadge(faixa: string | null) {
  const map: Record<string, string> = {
    quente: 'bg-green-100 text-green-800',
    morno: 'bg-amber-100 text-amber-800',
    frio: 'bg-slate-200 text-slate-700',
  }
  return map[faixa || ''] || 'bg-slate-100 text-slate-600'
}

export default function AuditoriaPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rodando, setRodando] = useState(false)
  const [email, setEmail] = useState('')
  const [sugestoes, setSugestoes] = useState<any[]>([])
  const [regras, setRegras] = useState<any[]>([])
  const [editando, setEditando] = useState<string | null>(null)
  const [textoRegra, setTextoRegra] = useState('')
  const [taxaAtual, setTaxaAtual] = useState<number | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  async function carregar() {
    const [sg, rg, tx] = await Promise.all([
      supabase
        .from('sugestoes_auditoria')
        .select('*, lead:leads(id, familia:familias(nome_responsavel))')
        .order('created_at', { ascending: false }),
      supabase
        .from('regras_aprendidas')
        .select('*')
        .eq('ativa', true)
        .order('criada_em', { ascending: false }),
      supabase.rpc('taxa_comparecimento', { desde: null, ate: new Date().toISOString() }),
    ])
    setSugestoes((sg.data as any[]) || [])
    setRegras((rg.data as any[]) || [])
    setTaxaAtual(typeof tx.data === 'number' ? tx.data : null)
    setLoading(false)
  }

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser()
      setEmail(u?.user?.email || '')
      await carregar()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function revisar(id: string, status: 'validada' | 'rejeitada') {
    setSugestoes((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)))
    await supabase
      .from('sugestoes_auditoria')
      .update({ status, revisado_por: email, revisado_em: new Date().toISOString() })
      .eq('id', id)
  }

  // Nível 2: promove uma candidata recorrente a REGRA GLOBAL (versionada, reversível).
  async function criarRegra(criterio: string, n: number, texto: string) {
    const t = texto.trim()
    if (!t) return
    // Guardrail do COO: fotografa a taxa conversa→compareceu ANTES da regra (baseline).
    const { data: baseline } = await supabase.rpc('taxa_comparecimento', { desde: null, ate: new Date().toISOString() })
    const { data: nova } = await supabase
      .from('regras_aprendidas')
      .insert({
        texto_regra: t,
        origem_hash: criterio,
        n_observacoes: n,
        status: 'ativa',
        ativa: true,
        criada_por: email || 'crm',
        kpi_baseline: baseline ?? null,
      })
      .select('id')
      .single()
    if (nova?.id) {
      await supabase.from('regras_eventos').insert({ regra_id: nova.id, acao: 'aplicar', por: email || 'crm' })
    }
    setEditando(null)
    setTextoRegra('')
    setAviso(`Regra criada e ativa. A Sara já a segue no próximo atendimento.`)
    await carregar()
  }

  // Rollback: desativa uma regra (a Sara para de segui-la imediatamente).
  async function desativarRegra(id: string) {
    await supabase
      .from('regras_aprendidas')
      .update({ ativa: false, status: 'aposentada', aposentada_em: new Date().toISOString(), motivo: 'Desativada manualmente' })
      .eq('id', id)
    await supabase.from('regras_eventos').insert({ regra_id: id, acao: 'aposentar', por: email || 'crm' })
    await carregar()
  }

  async function auditarAgora() {
    setRodando(true)
    setAviso(null)
    try {
      const r = await fetch('/api/cron/auditor', { method: 'POST' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'falha')
      setAviso(`Auditoria concluída: ${j.auditadas ?? 0} conversa(s) auditada(s).`)
      await carregar()
    } catch (e) {
      setAviso(`Erro ao auditar: ${e instanceof Error ? e.message : 'desconhecido'}`)
    } finally {
      setRodando(false)
    }
  }

  const pendentes = useMemo(() => sugestoes.filter((s) => s.status === 'pendente'), [sugestoes])
  const validadas = useMemo(() => sugestoes.filter((s) => s.status === 'validada'), [sugestoes])
  const rejeitadas = useMemo(() => sugestoes.filter((s) => s.status === 'rejeitada'), [sugestoes])

  // Regras candidatas (Nível 2): critérios cujo gap validado se repete.
  const candidatas = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of validadas) m.set(s.criterio, (m.get(s.criterio) || 0) + 1)
    return [...m.entries()].map(([criterio, n]) => ({ criterio, n })).sort((a, b) => b.n - a.n)
  }, [validadas])

  return (
    <div className="min-h-screen bg-[#F5F6FA] pl-16">
      <Topbar />
      <main className="mx-auto max-w-5xl p-6 md:p-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-[#1A237E]">
              <ShieldCheck className="h-6 w-6" /> Auditoria da Sara
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Sugestões do Auditor Cognitivo, previstas para <strong>comparecimento à visita</strong>. Aplicar confirma o diagnóstico; a recorrência vira regra.
            </p>
          </div>
          <button
            onClick={auditarAgora}
            disabled={rodando}
            className="inline-flex items-center gap-2 rounded-xl bg-[#1A237E] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#151d63] disabled:opacity-60"
          >
            {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {rodando ? 'Auditando…' : 'Auditar agora'}
          </button>
        </div>

        {aviso && (
          <div className="mb-5 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">{aviso}</div>
        )}

        {/* KPI-estrela */}
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#1A237E]/20 bg-white p-4">
          <div className="text-3xl font-bold text-[#1A237E]">{taxaAtual != null ? `${taxaAtual}%` : '—'}</div>
          <div className="text-sm text-slate-600">
            <div className="font-semibold text-slate-700">Taxa conversa → compareceu</div>
            <div className="text-xs text-slate-400">O número que o auditor existe para mover. Toda regra é medida contra ele.</div>
          </div>
        </div>

        {/* Contadores */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          {[
            { label: 'Pendentes', v: pendentes.length },
            { label: 'Aplicadas', v: validadas.length },
            { label: 'Rejeitadas', v: rejeitadas.length },
          ].map((c) => (
            <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-2xl font-bold text-slate-800">{c.v}</div>
              <div className="text-xs text-slate-500">{c.label}</div>
            </div>
          ))}
        </div>

        {/* Regras ATIVAS (Nível 2) — a Sara segue estas hoje */}
        {regras.length > 0 && (
          <div className="mb-6 rounded-xl border border-[#1A237E]/20 bg-[#1A237E]/5 p-4">
            <h2 className="mb-3 text-sm font-semibold text-[#1A237E]">Regras ativas da Sara ({regras.length})</h2>
            <div className="space-y-2">
              {regras.map((r) => {
                const base = typeof r.kpi_baseline === 'number' ? r.kpi_baseline : null
                const pos = typeof r.kpi_pos === 'number' ? r.kpi_pos : null
                const lift = base != null && pos != null ? Math.round((pos - base) * 10) / 10 : null
                return (
                  <div key={r.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
                    <div className="min-w-0">
                      <div className="text-sm text-slate-700">
                        <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                          {CRITERIO_LABEL[r.origem_hash] || r.origem_hash || 'regra'}
                        </span>
                        {r.texto_regra}
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-xs">
                        <span className="text-slate-400">
                          compareceu: {base != null ? `${base}%` : '—'} → {pos != null ? `${pos}%` : 'medindo…'}
                        </span>
                        {lift != null && (
                          <span className={`rounded px-1.5 py-0.5 font-medium ${lift > 0 ? 'bg-green-100 text-green-700' : lift < 0 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                            {lift > 0 ? `▲ +${lift}pp` : lift < 0 ? `▼ ${lift}pp (sem lift — reveja)` : '→ 0pp'}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => desativarRegra(r.id)}
                      className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-500 transition hover:bg-slate-50"
                      title="Desativar (a Sara para de seguir esta regra)"
                    >
                      Desativar
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Regras candidatas (Nível 2) */}
        {candidatas.length > 0 && (
          <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Regras candidatas (padrões que se repetem)</h2>
            <div className="space-y-2">
              {candidatas.map((c) => {
                const ok = c.n >= REGRA_MIN
                const jaTemRegra = regras.some((r) => r.origem_hash === c.criterio)
                const rep = validadas.find((s) => s.criterio === c.criterio)?.sugestao || ''
                return (
                  <div key={c.criterio} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-700">
                        {CRITERIO_LABEL[c.criterio] || c.criterio}
                        <span className="ml-2 text-xs text-slate-400">{c.n} aplicaç{c.n === 1 ? 'ão' : 'ões'}</span>
                      </span>
                      {jaTemRegra ? (
                        <span className="text-xs text-[#1A237E]">✓ já é regra ativa</span>
                      ) : ok ? (
                        <button
                          onClick={() => { setEditando(c.criterio); setTextoRegra(rep) }}
                          className="rounded-lg bg-[#1A237E] px-3 py-1 text-xs font-semibold text-white transition hover:bg-[#151d63]"
                        >
                          Aplicar como regra
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">faltam {REGRA_MIN - c.n} p/ virar regra</span>
                      )}
                    </div>
                    {editando === c.criterio && (
                      <div className="mt-3">
                        <textarea
                          value={textoRegra}
                          onChange={(e) => setTextoRegra(e.target.value)}
                          rows={2}
                          placeholder="Regra abstrata para a Sara (sem dados de nenhuma família específica)."
                          className="w-full rounded-lg border border-slate-300 p-2 text-sm"
                        />
                        <p className="mt-1 text-xs text-slate-400">Escreva um padrão geral, sem PII. Ex.: “Ao perguntarem o valor, ancore com um ‘a partir de R$X’ antes de convidar para a visita.”</p>
                        <div className="mt-2 flex gap-2">
                          <button onClick={() => criarRegra(c.criterio, c.n, textoRegra)} className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700">Confirmar regra</button>
                          <button onClick={() => { setEditando(null); setTextoRegra('') }} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">Cancelar</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Ao atingir {REGRA_MIN} aplicações do mesmo critério, você pode promovê-lo a regra global — versionada e reversível (Nível 2).
            </p>
          </div>
        )}

        {/* Lista de sugestões pendentes */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : pendentes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
            Nenhuma sugestão pendente. Clique em <strong>Auditar agora</strong> para o Auditor analisar as conversas de captação.
          </div>
        ) : (
          <div className="space-y-3">
            {pendentes.map((s) => (
              <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800">
                      {s.lead?.familia?.nome_responsavel || 'Família'}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${faixaBadge(s.faixa)}`}>
                      {s.faixa || '—'}{typeof s.score_preditivo === 'number' ? ` · ${s.score_preditivo}` : ''}
                    </span>
                    {typeof s.probabilidade_holistica === 'number' && (
                      <span className="text-xs text-slate-400">prob. comparecer ~{s.probabilidade_holistica}%</span>
                    )}
                  </div>
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                    {CRITERIO_LABEL[s.criterio] || s.criterio}
                  </span>
                </div>
                {s.diagnostico && <p className="mb-1 text-sm text-slate-600"><strong>Gap:</strong> {s.diagnostico}</p>}
                <p className="mb-3 text-sm text-slate-800"><strong>Sugestão:</strong> {s.sugestao}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => revisar(s.id, 'validada')}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-green-700"
                  >
                    <ThumbsUp className="h-4 w-4" /> Aplicar
                  </button>
                  <button
                    onClick={() => revisar(s.id, 'rejeitada')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                  >
                    <ThumbsDown className="h-4 w-4" /> Rejeitar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
