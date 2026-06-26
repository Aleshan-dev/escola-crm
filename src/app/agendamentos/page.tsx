'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'

type Tarefa = { id: string; titulo: string; tipo: string | null; data_hora: string; concluida: boolean }

const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']
const HOUR_START = 7
const HOUR_END = 22
const ROW_H = 48
const GRID_COLS = '50px repeat(7, 1fr)'

const TIPO_COR: Record<string, string> = {
  visita: 'bg-blue-100 border-blue-300 text-blue-800',
  ligacao: 'bg-amber-100 border-amber-300 text-amber-800',
  followup: 'bg-purple-100 border-purple-300 text-purple-800',
  reuniao: 'bg-green-100 border-green-300 text-green-800',
  geral: 'bg-slate-100 border-slate-300 text-slate-700',
}

function inicioSemana(base: Date): Date {
  const d = new Date(base)
  d.setHours(0, 0, 0, 0)
  const offset = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - offset)
  return d
}

export default function AgendamentosPage() {
  const supabase = createClient()
  const [semana, setSemana] = useState(() => inicioSemana(new Date()))
  const [loading, setLoading] = useState(true)
  const [tarefas, setTarefas] = useState<Tarefa[]>([])
  const [stats, setStats] = useState({ agendadas: 0, atrasadas: 0, realizadas: 0 })

  const fimSemana = useMemo(() => {
    const d = new Date(semana)
    d.setDate(d.getDate() + 7)
    return d
  }, [semana])

  const dias = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(semana)
    d.setDate(d.getDate() + i)
    return d
  }), [semana])

  const horas = useMemo(() => Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i), [])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('tarefas')
      .select('id, titulo, tipo, data_hora, concluida')
      .gte('data_hora', semana.toISOString())
      .lt('data_hora', fimSemana.toISOString())
    setTarefas((data as unknown as Tarefa[]) || [])

    const { data: vis } = await supabase.from('tarefas').select('data_hora, concluida').eq('tipo', 'visita')
    const now = Date.now()
    const list = (vis as unknown as { data_hora: string; concluida: boolean }[]) || []
    setStats({
      agendadas: list.filter((t) => !t.concluida && new Date(t.data_hora).getTime() >= now).length,
      atrasadas: list.filter((t) => !t.concluida && new Date(t.data_hora).getTime() < now).length,
      realizadas: list.filter((t) => t.concluida).length,
    })
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semana])

  function navegar(delta: number) {
    const d = new Date(semana)
    d.setDate(d.getDate() + delta * 7)
    setSemana(d)
  }

  const rotuloMes = dias[0].toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  const hojeStr = new Date().toDateString()

  function eventosDoDia(dia: Date) {
    return tarefas.filter((t) => new Date(t.data_hora).toDateString() === dia.toDateString())
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="flex-1 flex flex-col p-4">
        <div className="flex items-center gap-2 mb-3">
          <button onClick={() => navegar(-1)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-sm font-semibold capitalize">{rotuloMes}</span>
          <button onClick={() => navegar(1)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><ChevronRight className="w-4 h-4" /></button>
          <button onClick={() => setSemana(inicioSemana(new Date()))} className="ml-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50">Hoje</button>
        </div>

        <div className="flex gap-4">
          <div className="w-56 flex-shrink-0 hidden md:block">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-sm font-semibold mb-3">Visitas</div>
              <StatRow label="Agendadas" valor={stats.agendadas} cor="text-blue-600" />
              <StatRow label="Atrasadas" valor={stats.atrasadas} cor="text-red-600" />
              <StatRow label="Realizadas" valor={stats.realizadas} cor="text-green-600" />
            </div>
          </div>

          <div className="flex-1 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <div className="min-w-[700px]">
              <div className="grid border-b border-slate-100" style={{ gridTemplateColumns: GRID_COLS }}>
                <div />
                {dias.map((d, i) => {
                  const ehHoje = d.toDateString() === hojeStr
                  return (
                    <div key={i} className="py-2 text-center border-l border-slate-100">
                      <div className="text-[11px] text-slate-400 uppercase">{DIAS[i]}</div>
                      <div className={`text-sm font-semibold ${ehHoje ? 'text-blue-600' : 'text-slate-700'}`}>{d.getDate()}</div>
                    </div>
                  )
                })}
              </div>

              {loading ? (
                <div className="flex items-center gap-2 text-slate-500 p-8"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
              ) : (
                <div className="grid" style={{ gridTemplateColumns: GRID_COLS }}>
                  <div>
                    {horas.map((h) => (
                      <div key={h} style={{ height: ROW_H }} className="text-[10px] text-slate-400 text-right pr-1 -mt-1.5">{h}:00</div>
                    ))}
                  </div>
                  {dias.map((dia, di) => (
                    <div key={di} className="relative border-l border-slate-100" style={{ height: horas.length * ROW_H }}>
                      {horas.map((h) => <div key={h} style={{ height: ROW_H }} className="border-b border-slate-50" />)}
                      {eventosDoDia(dia).map((t) => {
                        const dt = new Date(t.data_hora)
                        const pos = (dt.getHours() + dt.getMinutes() / 60 - HOUR_START) * ROW_H
                        if (pos < 0 || pos > horas.length * ROW_H) return null
                        const cor = TIPO_COR[t.tipo || 'geral'] || TIPO_COR.geral
                        return (
                          <div key={t.id} className={`absolute left-1 right-1 rounded-md border px-1.5 py-1 text-[10px] leading-tight overflow-hidden ${cor} ${t.concluida ? 'opacity-60 line-through' : ''}`} style={{ top: pos, minHeight: ROW_H - 6 }}>
                            <div className="font-medium truncate">{t.titulo}</div>
                            <div className="opacity-70">{dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatRow({ label, valor, cor }: { label: string; valor: number; cor: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={`font-semibold ${cor}`}>{valor}</span>
    </div>
  )
}
