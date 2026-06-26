'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'

type Meta = { id: string; nome: string; valor_meta: number; periodo: string | null }

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

export default function MetasPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [itens, setItens] = useState<Meta[]>([])
  const [nome, setNome] = useState('')
  const [valor, setValor] = useState('')
  const [periodo, setPeriodo] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('metas_crescimento').select('*').order('criado_em', { ascending: false })
    setItens((data as unknown as Meta[]) || [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function adicionar() {
    setErro(null)
    if (!nome.trim()) { setErro('Informe o nome da meta.'); return }
    const { error } = await supabase.from('metas_crescimento').insert({
      nome: nome.trim(),
      valor_meta: Number(valor) || 0,
      periodo: periodo.trim() || null,
    })
    if (error) { setErro(error.message); return }
    setNome(''); setValor(''); setPeriodo(''); load()
  }
  async function remover(id: string) {
    await supabase.from('metas_crescimento').delete().eq('id', id); load()
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Metas de crescimento</h1>
        <p className="text-sm text-slate-500 mb-6">Defina metas de captação por período.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="rounded-lg bg-slate-50 p-3 mb-4 grid sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Nome</span>
              <input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} placeholder="Ex: Matrículas 2026" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Meta</span>
              <input type="number" value={valor} onChange={(e) => setValor(e.target.value)} className={inputCls} placeholder="0" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Período</span>
              <input value={periodo} onChange={(e) => setPeriodo(e.target.value)} className={inputCls} placeholder="2026" />
            </label>
            <button onClick={adicionar} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"><Plus className="w-4 h-4" /> Add</button>
          </div>
          {erro && <p className="text-sm text-red-600 mb-3">{erro}</p>}

          {loading ? (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
          ) : itens.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhuma meta cadastrada.</p>
          ) : (
            <div className="space-y-2">
              {itens.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                  <div>
                    <span className="text-sm font-medium">{m.nome}</span>
                    {m.periodo && <span className="text-xs text-slate-500 ml-2">{m.periodo}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-blue-600">{m.valor_meta}</span>
                    <button onClick={() => remover(m.id)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
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
