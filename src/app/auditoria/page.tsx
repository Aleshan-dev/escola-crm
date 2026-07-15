/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, ShieldCheck, RefreshCw, AlertTriangle, Lightbulb, ThumbsUp, Target, Pencil, ArrowRight } from 'lucide-react'

type Criterios = {
  acolhimento: number; humanizacao: number; diagnostico: number; escuta_ativa: number; construcao_valor: number
  objecoes: number; convite_visita: number; comunicacao: number; followup: number; probabilidade_matricula: number
}
type Reescrita = { original: string; sugestao: string }
type Detalhe = {
  lead_id: string; responsavel: string; nota: number; criterios: Criterios
  pontos_fortes: string[]; oportunidades: string[]; mensagens_reescrever: Reescrita[]
  melhor_resposta: string; proxima_acao: string; classificacao: string; estagio_funil: string; resumo: string
}
type Auditoria = {
  id: string; conversas_analisadas: number; nota_geral: number | null; resumo: string | null
  achados: string[]; sugestoes: string[]; detalhes: Detalhe[]; criado_em: string
}

const CRITERIOS: { key: keyof Criterios; label: string; max: number }[] = [
  { key: 'acolhimento', label: 'Acolhimento', max: 10 },
  { key: 'humanizacao', label: 'Humanização', max: 10 },
  { key: 'diagnostico', label: 'Diagnóstico', max: 10 },
  { key: 'escuta_ativa', label: 'Escuta ativa', max: 10 },
  { key: 'construcao_valor', label: 'Construção de valor', max: 10 },
  { key: 'objecoes', label: 'Objeções', max: 10 },
  { key: 'convite_visita', label: 'Convite p/ visita', max: 10 },
  { key: 'comunicacao', label: 'Comunicação', max: 10 },
  { key: 'followup', label: 'Follow-up', max: 10 },
  { key: 'probabilidade_matricula', label: 'Prob. matrícula', max: 100 },
]

function corNota(n: number | null) {
  if (n == null) return 'text-slate-400'
  if (n >= 80) return 'text-green-600'
  if (n >= 60) return 'text-amber-600'
  return 'text-red-600'
}
function corClass(c: string) {
  const l = (c || '').toLowerCase()
  if (l.includes('quente')) return 'bg-red-100 text-red-700'
  if (l.includes('morno')) return 'bg-amber-100 text-amber-700'
  return 'bg-slate-100 text-slate-600'
}
function barraCor(pct: number) {
  if (pct >= 0.8) return '#16a34a'
  if (pct >= 0.6) return '#d97706'
  return '#dc2626'
}

export default function AuditoriaPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rodando, setRodando] = useState(false)
  const [lista, setLista] = useState<Auditoria[]>([])
  const [sel, setSel] = useState<Auditoria | null>(null)

  async function carregar() {
    const { data } = await supabase.from('auditorias_sara').select('*').order('criado_em', { ascending: false }).limit(30)
    const arr = (data as unknown as Auditoria[]) || []
    setLista(arr)
    setSel((atual) => arr.find((a) => a.id === atual?.id) || arr[0] || null)
    setLoading(false)
  }
  useEffect(() => { carregar() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  async function rodarAgora() {
    if (rodando) return
    setRodando(true)
    try { await fetch('/api/admin/rodar-auditoria', { method: 'POST' }); await carregar() } finally { setRodando(false) }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="mx-auto w-full max-w-4xl p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><ShieldCheck className="h-5 w-5 text-blue-600" /> Auditoria da Sara</h1>
            <p className="text-sm text-slate-500">Avaliação diária do atendimento (10 critérios + recomendações).</p>
          </div>
          <button onClick={rodarAgora} disabled={rodando} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60">
            {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {rodando ? 'Analisando...' : 'Rodar agora'}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando...</div>
        ) : lista.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Ainda não há auditorias. Clique em &quot;Rodar agora&quot; para gerar a primeira.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[200px_1fr]">
            <div className="space-y-1">
              {lista.map((a) => (
                <button key={a.id} onClick={() => setSel(a)} className={`w-full rounded-lg border p-2.5 text-left text-sm transition ${sel?.id === a.id ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">{new Date(a.criado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
                    <span className={`font-semibold ${corNota(a.nota_geral)}`}>{a.nota_geral ?? '—'}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">{a.conversas_analisadas} conversa(s)</div>
                </button>
              ))}
            </div>

            {sel && (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-baseline gap-3">
                    <span className={`text-3xl font-bold ${corNota(sel.nota_geral)}`}>{sel.nota_geral ?? '—'}</span>
                    <span className="text-sm text-slate-500">/100 · média de {sel.conversas_analisadas} conversa(s)</span>
                  </div>
                  <p className="text-sm text-slate-700">{sel.resumo}</p>
                </div>

                {sel.sugestoes?.length > 0 && (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-indigo-900"><Lightbulb className="h-4 w-4" /> Sugestões de correção (dia)</div>
                    <ul className="space-y-1.5">{sel.sugestoes.map((s, i) => <li key={i} className="text-sm text-slate-700">• {s}</li>)}</ul>
                  </div>
                )}

                {sel.achados?.length > 0 && (
                  <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" /> Sinais do sistema</div>
                    <ul className="space-y-1">{sel.achados.map((a, i) => <li key={i} className="text-sm text-slate-700">• {a}</li>)}</ul>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="text-sm font-semibold text-slate-700">Conversas avaliadas</div>
                  {sel.detalhes?.map((d, i) => (
                    <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{d.responsavel}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${corClass(d.classificacao)}`}>{d.classificacao}</span>
                          <span className="text-[11px] text-slate-400">{d.estagio_funil}</span>
                        </div>
                        <span className={`text-lg font-bold ${corNota(d.nota)}`}>{d.nota}<span className="text-xs font-normal text-slate-400">/100</span></span>
                      </div>

                      {/* Critérios */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                        {CRITERIOS.map((c) => {
                          const v = (d.criterios?.[c.key] ?? 0) as number
                          const pct = c.max ? v / c.max : 0
                          return (
                            <div key={c.key} className="flex items-center gap-2">
                              <span className="w-32 truncate text-[11px] text-slate-500">{c.label}</span>
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                                <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: barraCor(pct) }} />
                              </div>
                              <span className="w-10 text-right text-[11px] font-medium text-slate-600">{v}{c.max === 100 ? '%' : `/${c.max}`}</span>
                            </div>
                          )
                        })}
                      </div>

                      {d.resumo && <p className="text-xs text-slate-600">{d.resumo}</p>}

                      <div className="grid gap-3 sm:grid-cols-2">
                        {d.pontos_fortes?.length > 0 && (
                          <div>
                            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-green-700"><ThumbsUp className="h-3.5 w-3.5" /> Pontos fortes</div>
                            <ul className="space-y-0.5">{d.pontos_fortes.map((p, j) => <li key={j} className="text-xs text-slate-600">• {p}</li>)}</ul>
                          </div>
                        )}
                        {d.oportunidades?.length > 0 && (
                          <div>
                            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700"><Target className="h-3.5 w-3.5" /> Oportunidades</div>
                            <ul className="space-y-0.5">{d.oportunidades.map((p, j) => <li key={j} className="text-xs text-slate-600">• {p}</li>)}</ul>
                          </div>
                        )}
                      </div>

                      {d.mensagens_reescrever?.length > 0 && (
                        <div>
                          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-700"><Pencil className="h-3.5 w-3.5" /> Mensagens para reescrever</div>
                          <div className="space-y-1.5">
                            {d.mensagens_reescrever.map((m, j) => (
                              <div key={j} className="rounded-lg bg-slate-50 p-2 text-xs">
                                <div className="text-slate-400 line-through">{m.original}</div>
                                <div className="text-slate-700">↳ {m.sugestao}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {d.melhor_resposta && (
                        <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-2 text-xs">
                          <span className="font-semibold text-blue-800">Melhor resposta agora: </span>
                          <span className="text-slate-700">{d.melhor_resposta}</span>
                        </div>
                      )}
                      {d.proxima_acao && (
                        <div className="flex items-start gap-1.5 text-xs text-slate-700">
                          <ArrowRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
                          <span><span className="font-semibold">Próxima ação:</span> {d.proxima_acao}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
