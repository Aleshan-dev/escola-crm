'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, GraduationCap, Users, type LucideIcon } from 'lucide-react'

type Lead = { id: string; coluna_id: string; criado_em: string; entrou_coluna_em: string; crianca: { serie_desejada: string | null } | null }
type Coluna = { id: string; nome: string; ordem: number }

function Card({ titulo, meta, realizado, prev, pct, total, icon: Icon }: { titulo: string; meta: number; realizado: number; prev: number; pct: string; total: number; icon: LucideIcon }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="rounded-lg bg-blue-50 p-1.5 text-blue-600"><Icon className="w-4 h-4" /></div>
        <span className="text-sm font-semibold">Número de <span className="text-blue-600">{titulo}</span></span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-center">
        <div><div className="text-[10px] uppercase text-slate-400">Meta</div><div className="text-2xl font-bold text-slate-800">{meta}</div></div>
        <div><div className="text-[10px] uppercase text-slate-400">Realizado</div><div className="text-2xl font-bold text-slate-800">{realizado}</div></div>
        <div><div className="text-[10px] uppercase text-slate-400">Previsão</div><div className="text-2xl font-bold text-red-600">{prev}</div><div className="text-[10px] text-slate-400">({pct}%)</div></div>
        <div><div className="text-[10px] uppercase text-slate-400">Total</div><div className="text-2xl font-bold text-blue-600">{total}</div></div>
      </div>
    </div>
  )
}

function Linha({ label, valor }: { label: string; valor: number }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-50 py-2 last:border-0">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{valor}</span>
    </div>
  )
}

export default function InicioPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [nome, setNome] = useState('')
  const [m, setM] = useState({ contatosTotal: 0, contatosMes: 0, metaContatos: 0, matriculasTotal: 0, matriculasMes: 0, metaMatriculas: 0, tarefasMes: 0 })
  const [porSerie, setPorSerie] = useState<{ serie: string; qtd: number }[]>([])

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser()
      if (u?.user?.email) setNome(u.user.email.split('@')[0])

      const [lr, cr, tr, mr] = await Promise.all([
        supabase.from('leads').select('id, coluna_id, criado_em, entrou_coluna_em, crianca:criancas(serie_desejada)').eq('arquivado', false),
        supabase.from('colunas').select('id, nome, ordem').order('ordem'),
        supabase.from('tarefas').select('id, criado_em'),
        supabase.from('metas_crescimento').select('nome, valor_meta'),
      ])
      const leads = (lr.data as unknown as Lead[]) || []
      const colunas = (cr.data as unknown as Coluna[]) || []
      const tarefas = (tr.data as unknown as { criado_em: string }[]) || []
      const metas = (mr.data as unknown as { nome: string; valor_meta: number }[]) || []

      const ini = new Date(); ini.setDate(1); ini.setHours(0, 0, 0, 0)
      const iniTs = ini.getTime()
      const colMatric = colunas.find((c) => /matric/i.test(c.nome))
      const somaMeta = (re: RegExp) => metas.filter((x) => re.test(x.nome || '')).reduce((s, x) => s + (x.valor_meta || 0), 0)

      setM({
        contatosTotal: leads.length,
        contatosMes: leads.filter((l) => new Date(l.criado_em).getTime() >= iniTs).length,
        metaContatos: somaMeta(/contato/i),
        matriculasTotal: colMatric ? leads.filter((l) => l.coluna_id === colMatric.id).length : 0,
        matriculasMes: colMatric ? leads.filter((l) => l.coluna_id === colMatric.id && new Date(l.entrou_coluna_em).getTime() >= iniTs).length : 0,
        metaMatriculas: somaMeta(/matr[ií]c/i),
        tarefasMes: tarefas.filter((t) => new Date(t.criado_em).getTime() >= iniTs).length,
      })

      const grupos: Record<string, number> = {}
      for (const l of leads) {
        const se = l.crianca?.serie_desejada || 'Sem série'
        grupos[se] = (grupos[se] || 0) + 1
      }
      setPorSerie(Object.entries(grupos).map(([serie, qtd]) => ({ serie, qtd })).sort((a, b) => b.qtd - a.qtd))
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function previsao(realizado: number) {
    const hoje = new Date()
    const dia = hoje.getDate()
    const diasMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate()
    return dia > 0 ? Math.round((realizado / dia) * diasMes) : realizado
  }
  function pct(prev: number, meta: number) {
    return meta > 0 ? ((prev / meta) * 100).toFixed(2) : '0.00'
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-6xl mx-auto w-full">
        <h1 className="text-xl font-semibold">Bem-vindo(a){nome ? `, ${nome}` : ''}!</h1>
        <p className="text-sm text-slate-500 mb-6">Um resumo do seu funil de captação.</p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-4">
            <Card titulo="novas matrículas" meta={m.metaMatriculas} realizado={m.matriculasMes} prev={previsao(m.matriculasMes)} pct={pct(previsao(m.matriculasMes), m.metaMatriculas)} total={m.matriculasTotal} icon={GraduationCap} />
            <Card titulo="novos contatos" meta={m.metaContatos} realizado={m.contatosMes} prev={previsao(m.contatosMes)} pct={pct(previsao(m.contatosMes), m.metaContatos)} total={m.contatosTotal} icon={Users} />

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-sm font-semibold mb-3">Resumo do mês</div>
              <Linha label="Matrículas realizadas" valor={m.matriculasMes} />
              <Linha label="Novos contatos" valor={m.contatosMes} />
              <Linha label="Tarefas cadastradas" valor={m.tarefasMes} />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-3">
              <div className="text-sm font-semibold mb-3">Acompanhamento por série</div>
              {porSerie.length === 0 ? (
                <p className="text-sm text-slate-400">Sem dados.</p>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {porSerie.map((s) => (
                    <div key={s.serie} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2">
                      <span className="text-sm text-slate-700">{s.serie}</span>
                      <span className="text-sm font-semibold text-blue-600">{s.qtd}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
