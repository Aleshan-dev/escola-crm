'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'

type Horario = { id: string; dia_semana: string; hora_inicio: string | null; hora_fim: string | null; ativo: boolean }

const DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado']
const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

function fmt(h: string | null) { return h ? h.slice(0, 5) : '--:--' }

export default function HorariosVisitaPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [itens, setItens] = useState<Horario[]>([])
  const [dia, setDia] = useState('Segunda-feira')
  const [ini, setIni] = useState('')
  const [fim, setFim] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('horarios_visita').select('*').order('hora_inicio')
    setItens((data as unknown as Horario[]) || [])
    setLoading(false)
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function adicionar() {
    setErro(null)
    if (!ini || !fim) { setErro('Informe início e fim.'); return }
    if (fim <= ini) { setErro('O fim deve ser maior que o início.'); return }
    const { error } = await supabase.from('horarios_visita').insert({ dia_semana: dia, hora_inicio: ini, hora_fim: fim })
    if (error) { setErro(error.message); return }
    setIni(''); setFim(''); load()
  }
  async function alternar(h: Horario) {
    await supabase.from('horarios_visita').update({ ativo: !h.ativo }).eq('id', h.id); load()
  }
  async function remover(id: string) {
    await supabase.from('horarios_visita').delete().eq('id', id); load()
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Horários de visita</h1>
        <p className="text-sm text-slate-500 mb-6">Faixas de horário disponíveis para visitas, por dia da semana.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="rounded-lg bg-slate-50 p-3 mb-4 grid sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Dia</span>
              <select value={dia} onChange={(e) => setDia(e.target.value)} className={inputCls}>
                {DIAS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
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
            <p className="text-sm text-slate-400">Nenhuma faixa cadastrada.</p>
          ) : (
            <div className="space-y-4">
              {DIAS.filter((d) => itens.some((h) => h.dia_semana === d)).map((d) => (
                <div key={d}>
                  <div className="text-sm font-medium text-slate-700 mb-2">{d}</div>
                  <div className="space-y-2">
                    {itens.filter((h) => h.dia_semana === d).map((h) => (
                      <div key={h.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                        <span className="text-sm font-medium">{fmt(h.hora_inicio)} <span className="text-slate-400 font-normal">às</span> {fmt(h.hora_fim)}</span>
                        <div className="flex items-center gap-2">
                          <button onClick={() => alternar(h)} className={`text-[11px] px-2 py-0.5 rounded-full ${h.ativo ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{h.ativo ? 'Ativo' : 'Inativo'}</button>
                          <button onClick={() => remover(h.id)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
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
