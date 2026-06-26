'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'

type Turno = { id: string; nome: string; hora_inicio: string | null; hora_fim: string | null; ativo: boolean }

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

export default function TurnosPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [itens, setItens] = useState<Turno[]>([])
  const [nome, setNome] = useState('')
  const [ini, setIni] = useState('')
  const [fim, setFim] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('turnos').select('*').order('ordem').order('nome')
    setItens((data as unknown as Turno[]) || [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function adicionar() {
    setErro(null)
    if (!nome.trim()) { setErro('Informe o nome do turno.'); return }
    const { error } = await supabase.from('turnos').insert({
      nome: nome.trim(),
      hora_inicio: ini || null,
      hora_fim: fim || null,
      ordem: itens.length,
    })
    if (error) { setErro(error.message); return }
    setNome(''); setIni(''); setFim(''); load()
  }
  async function alternar(t: Turno) {
    await supabase.from('turnos').update({ ativo: !t.ativo }).eq('id', t.id); load()
  }
  async function remover(id: string) {
    await supabase.from('turnos').delete().eq('id', id); load()
  }

  function fmt(h: string | null) { return h ? h.slice(0, 5) : '--:--' }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Turnos disponíveis</h1>
        <p className="text-sm text-slate-500 mb-6">Defina os turnos de funcionamento da escola.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="rounded-lg bg-slate-50 p-3 mb-4 grid sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Nome</span>
              <input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} placeholder="Ex: Integral" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Início</span>
              <input type="time" value={ini} onChange={(e) => setIni(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Fim</span>
              <input type="time" value={fim} onChange={(e) => setFim(e.target.value)} className={inputCls} />
            </label>
            <button onClick={adicionar} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"><Plus className="w-4 h-4" /> Add</button>
          </div>
          {erro && <p className="text-sm text-red-600 mb-3">{erro}</p>}

          {loading ? (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
          ) : itens.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum turno cadastrado.</p>
          ) : (
            <div className="space-y-2">
              {itens.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                  <div>
                    <span className="text-sm font-medium">{t.nome}</span>
                    <span className="text-xs text-slate-500 ml-2">{fmt(t.hora_inicio)} às {fmt(t.hora_fim)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => alternar(t)} className={`text-[11px] px-2 py-0.5 rounded-full ${t.ativo ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{t.ativo ? 'Ativo' : 'Inativo'}</button>
                    <button onClick={() => remover(t.id)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
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
