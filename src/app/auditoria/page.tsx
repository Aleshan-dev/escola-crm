/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2, Lightbulb } from 'lucide-react'

type Problema = { regra: string; descricao: string; gravidade: 'baixa' | 'media' | 'alta' }
type Detalhe = { lead_id: string; responsavel: string; nota: number; problemas: Problema[]; acertos: string[] }
type Auditoria = {
  id: string
  periodo_inicio: string
  periodo_fim: string
  conversas_analisadas: number
  nota_geral: number | null
  resumo: string | null
  achados: string[]
  sugestoes: string[]
  detalhes: Detalhe[]
  criado_em: string
}

function corNota(n: number | null) {
  if (n == null) return 'text-slate-400'
  if (n >= 80) return 'text-green-600'
  if (n >= 60) return 'text-amber-600'
  return 'text-red-600'
}
const corGrav: Record<string, string> = {
  alta: 'bg-red-100 text-red-700',
  media: 'bg-amber-100 text-amber-700',
  baixa: 'bg-slate-100 text-slate-600',
}

export default function AuditoriaPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rodando, setRodando] = useState(false)
  const [lista, setLista] = useState<Auditoria[]>([])
  const [sel, setSel] = useState<Auditoria | null>(null)

  async function carregar() {
    const { data } = await supabase
      .from('auditorias_sara')
      .select('*')
      .order('criado_em', { ascending: false })
      .limit(30)
    const arr = (data as unknown as Auditoria[]) || []
    setLista(arr)
    setSel((atual) => atual || arr[0] || null)
    setLoading(false)
  }

  useEffect(() => {
    carregar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function rodarAgora() {
    if (rodando) return
    setRodando(true)
    try {
      await fetch('/api/admin/rodar-auditoria', { method: 'POST' })
      await carregar()
    } finally {
      setRodando(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="mx-auto w-full max-w-4xl p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <ShieldCheck className="h-5 w-5 text-blue-600" /> Auditoria da Sara
            </h1>
            <p className="text-sm text-slate-500">Revisão diária do atendimento contra as regras propostas.</p>
          </div>
          <button
            onClick={rodarAgora}
            disabled={rodando}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60"
          >
            {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {rodando ? 'Analisando...' : 'Rodar agora'}
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando...</div>
        ) : lista.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
            Ainda não há auditorias. Clique em &quot;Rodar agora&quot; para gerar a primeira (analisa as conversas das últimas 24h).
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            {/* Histórico */}
            <div className="space-y-1">
              {lista.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSel(a)}
                  className={`w-full rounded-lg border p-2.5 text-left text-sm transition ${sel?.id === a.id ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">{new Date(a.criado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
                    <span className={`font-semibold ${corNota(a.nota_geral)}`}>{a.nota_geral ?? '—'}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">{a.conversas_analisadas} conversa(s)</div>
                </button>
              ))}
            </div>

            {/* Detalhe */}
            {sel && (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-baseline gap-3">
                    <span className={`text-3xl font-bold ${corNota(sel.nota_geral)}`}>{sel.nota_geral ?? '—'}</span>
                    <span className="text-sm text-slate-500">/100 · {sel.conversas_analisadas} conversa(s) analisada(s)</span>
                  </div>
                  <p className="text-sm text-slate-700">{sel.resumo}</p>
                </div>

                {sel.sugestoes?.length > 0 && (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-indigo-900"><Lightbulb className="h-4 w-4" /> Sugestões de correção</div>
                    <ul className="space-y-1.5">
                      {sel.sugestoes.map((s, i) => (
                        <li key={i} className="text-sm text-slate-700">• {s}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {sel.achados?.length > 0 && (
                  <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-4">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" /> Sinais do sistema</div>
                    <ul className="space-y-1">
                      {sel.achados.map((a, i) => (
                        <li key={i} className="text-sm text-slate-700">• {a}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="text-sm font-semibold text-slate-700">Conversas analisadas</div>
                  {sel.detalhes?.map((d, i) => (
                    <div key={i} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-sm font-medium">{d.responsavel}</span>
                        <span className={`text-sm font-semibold ${corNota(d.nota)}`}>{d.nota}</span>
                      </div>
                      {d.problemas?.length > 0 ? (
                        <ul className="space-y-1">
                          {d.problemas.map((p, j) => (
                            <li key={j} className="flex items-start gap-2 text-xs text-slate-700">
                              <span className={`mt-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${corGrav[p.gravidade] || corGrav.baixa}`}>{p.gravidade}</span>
                              <span><span className="text-slate-400">{p.regra}:</span> {p.descricao}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="flex items-center gap-1.5 text-xs text-green-600"><CheckCircle2 className="h-3.5 w-3.5" /> Sem problemas detectados</div>
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
