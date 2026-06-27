'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, GraduationCap, Users, BarChart3, type LucideIcon } from 'lucide-react'

type Lead = { id: string; coluna_id: string; criado_em: string; entrou_coluna_em: string; responsavel_id: string | null; crianca: { serie_desejada: string | null } | null }
type Coluna = { id: string; nome: string; ordem: number; funil_id: string }
type Tarefa = { id: string; criado_em: string; lead_id: string | null; responsavel_id: string | null }
type Funil = { id: string; nome: string }
type Usuario = { id: string; nome: string }

const PERIODOS = [{ v: 'hoje', l: 'Hoje' }, { v: 'semana', l: 'Semana' }, { v: 'mes', l: 'Mês' }, { v: 'ano', l: 'Ano' }]

function inicioPeriodo(p: string): number {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  if (p === 'hoje') return d.getTime()
  if (p === 'semana') { d.setDate(d.getDate() - 6); return d.getTime() }
  if (p === 'ano') { d.setMonth(0, 1); return d.getTime() }
  d.setDate(1); return d.getTime()
}

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

export default function InicioPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [nome, setNome] = useState('')
  const [funis, setFunis] = useState<Funil[]>([])
  const [funilSel, setFunilSel] = useState('')
  const [colunas, setColunas] = useState<Coluna[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [tarefas, setTarefas] = useState<Tarefa[]>([])
  const [metas, setMetas] = useState<{ nome: string; valor_meta: number }[]>([])
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [periodo, setPeriodo] = useState('mes')

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser()
      if (u?.user?.email) setNome(u.user.email.split('@')[0])
      const [fr, cr, lr, tr, mr, ur] = await Promise.all([
        supabase.from('funis').select('id, nome').order('criado_em'),
        supabase.from('colunas').select('id, nome, ordem, funil_id').order('ordem'),
        supabase.from('leads').select('id, coluna_id, criado_em, entrou_coluna_em, responsavel_id, crianca:criancas(serie_desejada)').eq('arquivado', false),
        supabase.from('tarefas').select('id, criado_em, lead_id, responsavel_id'),
        supabase.from('metas_crescimento').select('nome, valor_meta'),
        supabase.from('usuarios').select('id, nome'),
      ])
      const fs = (fr.data as unknown as Funil[]) || []
      setFunis(fs)
      setFunilSel(fs[0]?.id || '')
      setColunas((cr.data as unknown as Coluna[]) || [])
      setLeads((lr.data as unknown as Lead[]) || [])
      setTarefas((tr.data as unknown as Tarefa[]) || [])
      setMetas((mr.data as unknown as { nome: string; valor_meta: number }[]) || [])
      setUsuarios((ur.data as unknown as Usuario[]) || [])
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dados = useMemo(() => {
    const colsFunil = colunas.filter((c) => !funilSel || c.funil_id === funilSel)
    const colIds = new Set(colsFunil.map((c) => c.id))
    const leadsFunil = leads.filter((l) => colIds.has(l.coluna_id))
    const leadIds = new Set(leadsFunil.map((l) => l.id))
    const tarefasFunil = tarefas.filter((t) => t.lead_id && leadIds.has(t.lead_id))
    const colMatric = colsFunil.find((c) => /matric/i.test(c.nome))
    const iniMes = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime() })()
    const somaMeta = (re: RegExp) => metas.filter((x) => re.test(x.nome || '')).reduce((s, x) => s + (x.valor_meta || 0), 0)

    const contatosMes = leadsFunil.filter((l) => new Date(l.criado_em).getTime() >= iniMes).length
    const matriculasMes = colMatric ? leadsFunil.filter((l) => l.coluna_id === colMatric.id && new Date(l.entrou_coluna_em).getTime() >= iniMes).length : 0

    const porEtapa = colsFunil.map((c) => ({ nome: c.nome, qtd: leadsFunil.filter((l) => l.coluna_id === c.id).length }))
    const maxEtapa = Math.max(1, ...porEtapa.map((e) => e.qtd))

    const gs: Record<string, number> = {}
    for (const l of leadsFunil) { const s = l.crianca?.serie_desejada || 'Sem série'; gs[s] = (gs[s] || 0) + 1 }
    const porSerie = Object.entries(gs).map(([serie, qtd]) => ({ serie, qtd })).sort((a, b) => b.qtd - a.qtd)

    const ini = inicioPeriodo(periodo)
    const nomeUsuario = (id: string | null) => usuarios.find((x) => x.id === id)?.nome || 'Sem responsável'
    const opMap: Record<string, { nome: string; matriculas: number; tarefas: number; contatos: number }> = {}
    const garante = (id: string | null) => { const k = id || 'sem'; if (!opMap[k]) opMap[k] = { nome: nomeUsuario(id), matriculas: 0, tarefas: 0, contatos: 0 }; return opMap[k] }
    for (const l of leadsFunil) {
      if (new Date(l.criado_em).getTime() >= ini) garante(l.responsavel_id).contatos++
      if (colMatric && l.coluna_id === colMatric.id && new Date(l.entrou_coluna_em).getTime() >= ini) garante(l.responsavel_id).matriculas++
    }
    for (const t of tarefasFunil) {
      if (new Date(t.criado_em).getTime() >= ini) garante(t.responsavel_id).tarefas++
    }
    const operadores = Object.values(opMap)
    if (operadores.length === 0) operadores.push({ nome: 'Sem responsável', matriculas: 0, tarefas: 0, contatos: 0 })

    return {
      contatosTotal: leadsFunil.length, contatosMes, metaContatos: somaMeta(/contato/i),
      matriculasTotal: colMatric ? leadsFunil.filter((l) => l.coluna_id === colMatric.id).length : 0,
      matriculasMes, metaMatriculas: somaMeta(/matr[ií]c/i),
      porEtapa, maxEtapa, porSerie, operadores,
    }
  }, [colunas, leads, tarefas, metas, usuarios, funilSel, periodo])

  function previsao(realizado: number) {
    const hoje = new Date(); const dia = hoje.getDate()
    const diasMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate()
    return dia > 0 ? Math.round((realizado / dia) * diasMes) : realizado
  }
  function pct(p: number, meta: number) { return meta > 0 ? ((p / meta) * 100).toFixed(2) : '0.00' }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-6xl mx-auto w-full">
        <h1 className="text-xl font-semibold">Bem-vindo(a){nome ? `, ${nome}` : ''}!</h1>
        <p className="text-sm text-slate-500 mb-5">Desde seu último acesso, aqui está o resumo do funil.</p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Funil</label>
              <select value={funilSel} onChange={(e) => setFunilSel(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 bg-white max-w-sm w-full">
                {funis.length === 0 && <option value="">Todos</option>}
                {funis.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </select>
            </div>

            <div className="grid lg:grid-cols-3 gap-4">
              <Card titulo="novas matrículas" meta={dados.metaMatriculas} realizado={dados.matriculasMes} prev={previsao(dados.matriculasMes)} pct={pct(previsao(dados.matriculasMes), dados.metaMatriculas)} total={dados.matriculasTotal} icon={GraduationCap} />
              <Card titulo="novos contatos" meta={dados.metaContatos} realizado={dados.contatosMes} prev={previsao(dados.contatosMes)} pct={pct(previsao(dados.contatosMes), dados.metaContatos)} total={dados.contatosTotal} icon={Users} />
              <div className="rounded-xl border border-slate-200 bg-white p-5">
                <div className="text-sm font-semibold mb-3">Por série</div>
                {dados.porSerie.length === 0 ? <p className="text-sm text-slate-400">Sem dados.</p> : (
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {dados.porSerie.map((s) => (
                      <div key={s.serie} className="flex items-center justify-between text-sm"><span className="text-slate-600">{s.serie}</span><span className="font-semibold text-blue-600">{s.qtd}</span></div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center gap-2 text-sm font-semibold mb-4"><BarChart3 className="w-4 h-4 text-blue-600" /> Leads por etapa</div>
              <div className="space-y-2">
                {dados.porEtapa.map((e) => (
                  <div key={e.nome} className="flex items-center gap-3">
                    <span className="w-36 text-xs text-slate-600 truncate text-right">{e.nome}</span>
                    <div className="flex-1 bg-slate-100 rounded-full h-4 overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${(e.qtd / dados.maxEtapa) * 100}%` }} />
                    </div>
                    <span className="w-8 text-sm font-semibold text-slate-700 text-right">{e.qtd}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="text-sm font-semibold">Acompanhamento de operadores</span>
                <div className="flex gap-1">
                  {PERIODOS.map((p) => (
                    <button key={p.v} onClick={() => setPeriodo(p.v)} className={`text-xs px-2.5 py-1 rounded-lg font-medium ${periodo === p.v ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50'}`}>{p.l}</button>
                  ))}
                </div>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {dados.operadores.map((op, i) => (
                  <div key={i} className="rounded-lg border border-slate-100 p-3">
                    <div className="text-sm font-medium mb-2">{op.nome}</div>
                    <div className="flex items-center justify-between text-xs py-0.5"><span className="text-slate-500">Matrículas realizadas</span><span className="font-semibold">{op.matriculas}</span></div>
                    <div className="flex items-center justify-between text-xs py-0.5"><span className="text-slate-500">Tarefas cadastradas</span><span className="font-semibold">{op.tarefas}</span></div>
                    <div className="flex items-center justify-between text-xs py-0.5"><span className="text-slate-500">Novos contatos</span><span className="font-semibold">{op.contatos}</span></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
