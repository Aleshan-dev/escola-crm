/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, BellRing, RefreshCw, MessageSquare, Check, Clock } from 'lucide-react'

type Pendente = {
  id: string
  motivo_transbordo: string | null
  transbordo_em: string | null
  familia: { nome_responsavel: string | null; telefone: string | null } | null
  coluna: { nome: string | null } | null
}

function tempoRelativo(iso: string | null) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return `há ${d} dia${d > 1 ? 's' : ''}`
}

export default function PendentesPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [lista, setLista] = useState<Pendente[]>([])
  const [resolvendo, setResolvendo] = useState<string | null>(null)

  async function carregar() {
    const { data } = await supabase
      .from('leads')
      .select('id, motivo_transbordo, transbordo_em, familia:familias(nome_responsavel, telefone), coluna:colunas(nome)')
      .eq('precisa_atendimento_humano', true)
      .eq('arquivado', false)
      .order('transbordo_em', { ascending: false, nullsFirst: false })
    setLista((data as unknown as Pendente[]) || [])
    setLoading(false)
  }
  useEffect(() => { carregar() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  async function resolver(id: string) {
    if (resolvendo) return
    setResolvendo(id)
    try {
      await supabase
        .from('leads')
        .update({ precisa_atendimento_humano: false, transbordo_em: null })
        .eq('id', id)
      setLista((prev) => prev.filter((p) => p.id !== id))
    } finally {
      setResolvendo(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="mx-auto w-full max-w-3xl p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <BellRing className="h-5 w-5 text-amber-600" /> Atendimentos pendentes
              {lista.length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-bold text-amber-700">{lista.length}</span>
              )}
            </h1>
            <p className="text-sm text-slate-500">Conversas em que a Sara pausou e aguardam você. Confiável — não depende do WhatsApp.</p>
          </div>
          <button onClick={() => { setLoading(true); carregar() }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando...</div>
        ) : lista.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            <Check className="mx-auto mb-2 h-6 w-6 text-green-500" />
            Nenhum atendimento pendente. Tudo em dia. 🎉
          </div>
        ) : (
          <div className="space-y-2">
            {lista.map((p) => (
              <div key={p.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{p.familia?.nome_responsavel || 'Família'}</span>
                      {p.coluna?.nome && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{p.coluna.nome}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">{p.familia?.telefone || ''}</div>
                    <p className="mt-1.5 text-sm text-slate-600">{p.motivo_transbordo || 'Atendimento humano solicitado.'}</p>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Clock className="h-3 w-3" /> {tempoRelativo(p.transbordo_em)}</div>
                  </div>
                  <div className="flex flex-shrink-0 flex-col gap-1.5">
                    <Link href={`/chat?lead=${p.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700">
                      <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
                    </Link>
                    <button onClick={() => resolver(p.id)} disabled={resolvendo === p.id} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                      {resolvendo === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Resolver
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
