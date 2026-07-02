'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'

type Inv = { id: string; canal: string; periodo: string; valor: number }

const CANAIS = ['meta-ads', 'organico']
const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

function mesAtual() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function fmtBRL(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export default function InvestimentoPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [itens, setItens] = useState<Inv[]>([])
  const [canal, setCanal] = useState('meta-ads')
  const [periodo, setPeriodo] = useState(mesAtual())
  const [valor, setValor] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('investimento_canal')
      .select('*')
      .order('periodo', { ascending: false })
    setItens((data as unknown as Inv[]) || [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function salvar() {
    setErro(null)
    const v = parseFloat(valor.replace(',', '.'))
    if (!canal.trim()) { setErro('Informe o canal.'); return }
    if (!periodo) { setErro('Informe o mês.'); return }
    if (isNaN(v) || v < 0) { setErro('Informe um valor válido.'); return }
    setSalvando(true)
    const { error } = await supabase.from('investimento_canal').upsert(
      { canal: canal.trim(), periodo, valor: v, atualizado_em: new Date().toISOString() },
      { onConflict: 'canal,periodo' }
    )
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setValor('')
    load()
  }
  async function remover(id: string) {
    await supabase.from('investimento_canal').delete().eq('id', id)
    load()
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Investimento por canal</h1>
        <p className="text-sm text-slate-500 mb-6">Lance quanto foi investido em cada canal por mês. Usado para calcular o CAC na tela inicial.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="rounded-lg bg-slate-50 p-3 mb-4 grid sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Canal</span>
              <input list="canais" value={canal} onChange={(e) => setCanal(e.target.value)} className={inputCls} placeholder="meta-ads" />
              <datalist id="canais">{CANAIS.map((c) => <option key={c} value={c} />)}</datalist>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Mês</span>
              <input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Valor (R$)</span>
              <input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} className={inputCls} placeholder="0,00" />
            </label>
            <button onClick={salvar} disabled={salvando} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Salvar</button>
          </div>
          {erro && <p className="text-sm text-red-600 mb-3">{erro}</p>}

          {loading ? (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
          ) : itens.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum investimento lançado ainda.</p>
          ) : (
            <div className="space-y-2">
              {itens.map((i) => (
                <div key={i.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                  <span className="text-sm font-medium text-slate-700 w-32">{i.canal}</span>
                  <span className="text-sm text-slate-500 w-24">{i.periodo}</span>
                  <span className="text-sm font-semibold text-slate-800 flex-1 text-right">{fmtBRL(Number(i.valor))}</span>
                  <button onClick={() => remover(i.id)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
