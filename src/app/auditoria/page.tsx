/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, ShieldCheck, RefreshCw, Lightbulb, ThumbsUp, Target, Pencil, ArrowRight, ChevronDown, ChevronRight } from 'lucide-react'

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
type Conversa = Detalhe & { _key: string; _data: string }

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
function Criterio({ label, valor, max }: { label: string; valor: number; max: number }) {
  const pct = max ? valor / max : 0
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 truncate text-[11px] text-slate-500">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: barraCor(pct) }} />
      </div>
      <span className="w-10 text-right text-[11px] font-medium text-slate-600">{max === 100 ? `${valor}%` : `${valor}/${max}`}</span>
    </div>
  )
}

export default function AuditoriaPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rodando, setRodando] = useState(false)
  const [lista, setLista] = useState<Auditoria[]>([])
  const [abertos, setAbertos] = useState<Set<string>>(new Set())

  async function carregar() {
    const { data } = await supabase.from('auditorias_sara').select('*').order('criado_em', { ascending: false }).limit(30)
    setLista((data as unknown as Auditoria[]) || [])
    setLoading(false)
  }
  useEffect(() => { carregar() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  async function rodarAgora() {
    if (rodando) return
    setRodando(true)
    try { await fetch('/api/admin/rodar-auditoria', { method: 'POST' }); await carregar() } finally { setRodando(false) }
  }

  // Agregado geral (todas as conversas de todas as auditorias carregadas)
  const g = useMemo(() => {
    const conversas: Conversa[] = lista.flatMap((a) =>
      (a.detalhes || []).map((d, i) => ({ ...d, _key: `${a.id}-${i}`, _data: a.criado_em }))
    )
    const notas = conversas.map((c) => c.nota).filter((n) => n > 0)
    const notaGeral = notas.length ? Math.round(notas.reduce((s, n) => s + n, 0) / notas.length) : null
    const mediaCrit = (k: keyof Criterios) => {
      const vals = conversas.map((c) => c.criterios?.[k] ?? 0)
      return vals.length ? Math.round(vals.reduce((s, n) => s + n, 0) / vals.length) : 0
    }
    const recomendacoes = lista[0]?.sugestoes || []
    return { conversas, notaGeral, mediaCrit, recomendacoes, totalAuditorias: lista.length }
  }, [lista])

  function toggle(k: string) {
    setAbertos((prev) => {
      const n = new Set(prev)
      n.has(k) ? n.delete(k) : n.add(k)
      return n
    })
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="mx-auto w-full max-w-3xl p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><ShieldCheck className="h-5 w-5 text-blue-600" /> Auditoria da Sara</h1>
            <p className="text-sm text-slate-500">Visão geral do atendimento — clique numa conversa para ver os detalhes.</p>
          </div>
          <button onClick={rodarAgora} disabled={rodando} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60">
            {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {rodando ? 'Analisando...' : 'Rodar agora'}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando...</div>
        ) : g.conversas.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Ainda não há avaliações. Clique em &quot;Rodar agora&quot; para gerar a primeira.</div>
        ) : (
          <div className="space-y-4">
            {/* Dashboard geral */}
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="mb-4 flex items-baseline gap-3">
                <span className={`text-4xl font-bold ${corNota(g.notaGeral)}`}>{g.notaGeral ?? '—'}</span>
                <div className="text-sm text-slate-500">
                  <div>nota geral média</div>
                  <div className="text-xs text-slate-400">{g.conversas.length} conversa(s) · {g.totalAuditorias} auditoria(s)</div>
                </div>
              </div>
              <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {CRITERIOS.map((c) => <Criterio key={c.key} label={c.label} valor={g.mediaCrit(c.key)} max={c.max} />)}
              </div>
            </div>

            {/* Recomendações consolidadas (última auditoria) */}
            {g.recomendacoes.length > 0 && (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-indigo-900"><Lightbulb className="h-4 w-4" /> Recomendações</div>
                <ul className="space-y-1.5">{g.recomendacoes.map((s, i) => <li key={i} className="text-sm text-slate-700">• {s}</li>)}</ul>
              </div>
            )}

            {/* Conversas avaliadas — expansíveis */}
            <div>
              <div className="mb-2 text-sm font-semibold text-slate-700">Conversas avaliadas</div>
              <div className="space-y-2">
                {g.conversas.map((d) => {
                  const aberto = abertos.has(d._key)
                  return (
                    <div key={d._key} className="rounded-xl border border-slate-200 bg-white">
                      <button onClick={() => toggle(d._key)} className="flex w-full items-center gap-2 p-3 text-left">
                        {aberto ? <ChevronDown className="h-4 w-4 flex-shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-400" />}
                        <span className="text-sm font-medium">{d.responsavel}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${corClass(d.classificacao)}`}>{d.classificacao}</span>
                        <span className="hidden text-[11px] text-slate-400 sm:inline">{d.estagio_funil}</span>
                        <span className="ml-auto text-[11px] text-slate-400">{new Date(d._data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
                        <span className={`text-lg font-bold ${corNota(d.nota)}`}>{d.nota}</span>
                      </button>

                      {aberto && (
                        <div className="space-y-3 border-t border-slate-100 p-4">
                          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                            {CRITERIOS.map((c) => <Criterio key={c.key} label={c.label} valor={(d.criterios?.[c.key] ?? 0) as number} max={c.max} />)}
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
                              <span className="font-semibold text-blue-800">Melhor resposta agora: </span><span className="text-slate-700">{d.melhor_resposta}</span>
                            </div>
                          )}
                          {d.proxima_acao && (
                            <div className="flex items-start gap-1.5 text-xs text-slate-700">
                              <ArrowRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-slate-400" />
                              <span><span className="font-semibold">Próxima ação:</span> {d.proxima_acao}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
