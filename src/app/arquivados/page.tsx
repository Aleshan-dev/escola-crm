'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, RotateCcw, Trash2 } from 'lucide-react'

type Arq = {
  id: string
  familia_id: string
  criado_em: string
  familia: { nome_responsavel: string; telefone: string | null } | null
  crianca: { nome: string } | null
}

export default function ArquivadosPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [itens, setItens] = useState<Arq[]>([])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('leads')
      .select('id, familia_id, criado_em, familia:familias(nome_responsavel, telefone), crianca:criancas(nome)')
      .eq('arquivado', true)
      .order('criado_em', { ascending: false })
    setItens((data as unknown as Arq[]) || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function restaurar(id: string) {
    await supabase.from('leads').update({ arquivado: false }).eq('id', id)
    load()
  }

  async function excluir(it: Arq) {
    if (!window.confirm('Excluir definitivamente? Apaga o lead e todo o histórico (mensagens, tarefas, anotações). Não dá pra desfazer.')) return
    await supabase.from('leads').delete().eq('id', it.id)
    const { count } = await supabase.from('leads').select('id', { count: 'exact', head: true }).eq('familia_id', it.familia_id)
    if (!count) await supabase.from('familias').delete().eq('id', it.familia_id)
    load()
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/kanban" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Kanban</Link>
        <h1 className="text-xl font-semibold mb-1">Leads arquivados</h1>
        <p className="text-sm text-slate-500 mb-6">Eles não aparecem no funil nem nas métricas. Você pode restaurar ou excluir de vez.</p>

        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-slate-500"><Loader2 className="inline w-5 h-5 animate-spin mr-2" />Carregando...</div>
          ) : itens.length === 0 ? (
            <div className="p-8 text-center text-slate-400">Nenhum lead arquivado.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {itens.map((it) => (
                <div key={it.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{it.familia?.nome_responsavel || 'Sem nome'}</div>
                    <div className="text-xs text-slate-500 truncate">
                      {it.familia?.telefone || '—'}{it.crianca ? ` · ${it.crianca.nome}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => restaurar(it.id)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"><RotateCcw className="w-4 h-4" /> Restaurar</button>
                    <button onClick={() => excluir(it)} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /> Excluir</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
