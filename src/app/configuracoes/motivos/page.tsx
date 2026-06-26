'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'

type Item = { id: string; nome: string; ativo: boolean }

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

export default function MotivosPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [itens, setItens] = useState<Item[]>([])
  const [nome, setNome] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('motivos_perda').select('*').order('ordem').order('nome')
    setItens((data as unknown as Item[]) || [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function adicionar() {
    setErro(null)
    if (!nome.trim()) { setErro('Informe o motivo.'); return }
    const { error } = await supabase.from('motivos_perda').insert({ nome: nome.trim(), ordem: itens.length })
    if (error) { setErro(error.message); return }
    setNome(''); load()
  }
  async function alternar(i: Item) {
    await supabase.from('motivos_perda').update({ ativo: !i.ativo }).eq('id', i.id); load()
  }
  async function remover(id: string) {
    await supabase.from('motivos_perda').delete().eq('id', id); load()
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Motivos de perda</h1>
        <p className="text-sm text-slate-500 mb-6">Padronize os motivos pelos quais um lead é perdido.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="rounded-lg bg-slate-50 p-3 mb-4 grid sm:grid-cols-[1fr_auto] gap-2 items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Motivo</span>
              <input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} placeholder="Ex: Escolheu outra escola" />
            </label>
            <button onClick={adicionar} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"><Plus className="w-4 h-4" /> Adicionar</button>
          </div>
          {erro && <p className="text-sm text-red-600 mb-3">{erro}</p>}

          {loading ? (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
          ) : itens.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum motivo cadastrado.</p>
          ) : (
            <div className="space-y-2">
              {itens.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                  <span className="text-sm font-medium">{i.nome}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => alternar(i)} className={`text-[11px] px-2 py-0.5 rounded-full ${i.ativo ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{i.ativo ? 'Ativo' : 'Inativo'}</button>
                    <button onClick={() => remover(i.id)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
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
