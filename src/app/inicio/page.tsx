/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, LineChart, ChevronLeft, ChevronRight, ArrowRight } from 'lucide-react'
import Link from 'next/link'

type Row = { nome: string; qtd: number }

function brl(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function inicioPeriodo(p: string): number {
  const d = new Date(); d.setHours(0, 0, 0, 0)
  if (p === 'hoje') return d.getTime()
  if (p === 'semana') { d.setDate(d.getDate() - 6); return d.getTime() }
  if (p === 'ano') { d.setMonth(0, 1); return d.getTime() }
  d.setDate(1); return d.getTime()
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

export default function InicioPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [nomeUser, setNomeUser] = useState('')
  const [funilSel, setFunilSel] = useState('')
  const [funis, setFunis] = useState<any[]>([])
  const [colunas, setColunas] = useState<any[]>([])
  const [leads, setLeads] = useState<any[]>([])
  const [tarefas, setTarefas] = useState<any[]>([])
  const [metas, setMetas] = useState<any[]>([])
  const [usuarios, setUsuarios] = useState<any[]>([])
  const [dim, setDim] = useState<'serie' | 'origem' | 'dono'>('serie')
  const [periodo, setPeriodo] = useState('mes')
  const [fstats, setFstats] = useState<any>(null)
  const [invs, setInvs] = useState<any[]>([])

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser()
      const email = u?.user?.email || ''
      setNomeUser(email ? email.split('@')[0] : '')
      const [fr, cr, lr, tr, mr, ur] = await Promise.all([
        supabase.from('funis').select('id, nome, is_padrao').order('criado_em'),
        supabase.from('colunas').select('id, nome, ordem, funil_id').order('ordem'),
        supabase.from('leads').select('*, crianca:criancas(serie_desejada), familia:familias(canal)').eq('arquivado', false),
        supabase.from('tarefas').select('id, criado_em, lead_id, responsavel_id'),
        supabase.from('metas_crescimento').select('nome, valor_meta'),
        supabase.from('usuarios').select('id, nome'),
      ])
      const fs = (fr.data as any[]) || []
      setFunis(fs)
      // Dashboard unificado: sempre o funil padrão (captação), sem seletor.
      setFunilSel(fs.find((f) => f.is_padrao)?.id || fs[0]?.id || '')
      setColunas((cr.data as any[]) || [])
      setLeads((lr.data as any[]) || [])
      setTarefas((tr.data as any[]) || [])
      setMetas((mr.data as any[]) || [])
      setUsuarios((ur.data as any[]) || [])
      const { data: fs2 } = await supabase.from('v_followup_stats').select('*').maybeSingle()
      setFstats(fs2 || null)
      const { data: iv } = await supabase.from('investimento_canal').select('canal, periodo, valor')
      setInvs((iv as any[]) || [])
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const nomeUsuario = (id: string | null) => usuarios.find((x) => x.id === id)?.nome || 'Sem responsável'

  const d = useMemo(() => {
    const cols = colunas.filter((c) => !funilSel || c.funil_id === funilSel)
    const colIds = new Set(cols.map((c) => c.id))
    const ls = leads.filter((l) => colIds.has(l.coluna_id))
    const leadIds = new Set(ls.map((l) => l.id))
    const ts = tarefas.filter((t) => t.lead_id && leadIds.has(t.lead_id))
    const colMatricCaptacao = cols.find((c) => /matric/i.test(c.nome))
    const iniMes = (() => { const x = new Date(); x.setDate(1); x.setHours(0, 0, 0, 0); return x.getTime() })()
    const somaMeta = (re: RegExp) => metas.filter((x) => re.test(x.nome || '')).reduce((s, x) => s + (x.valor_meta || 0), 0)

    // Quando um lead é matriculado, ele é transferido para o funil dedicado "Matriculados"
    // (colunas por série/turma), saindo do funil de captação. Portanto contamos as matrículas
    // em TODAS as colunas desse funil, além da coluna "Matriculados" da própria captação.
    const funilMatric = funis.find((f) => !f.is_padrao && /matric/i.test(f.nome || ''))
    const colMatricIds = new Set<string>()
    if (funilMatric) colunas.filter((c) => c.funil_id === funilMatric.id).forEach((c) => colMatricIds.add(c.id))
    if (colMatricCaptacao) colMatricIds.add(colMatricCaptacao.id)
    const nomeColuna = (id: string) => colunas.find((c) => c.id === id)?.nome || ''

    const contatosMes = ls.filter((l) => new Date(l.criado_em).getTime() >= iniMes).length
    const matricLeads = leads.filter((l) => colMatricIds.has(l.coluna_id))
    const matriculasMes = matricLeads.filter((l) => new Date(l.entrou_coluna_em || l.criado_em).getTime() >= iniMes).length

    // Para matriculados do funil por série, a "série" é a própria coluna (turma); na captação, usa a série desejada.
    const chave = (l: any) => dim === 'serie'
      ? (colMatricCaptacao && l.coluna_id === colMatricCaptacao.id ? (l.crianca?.serie_desejada || 'Sem série') : (nomeColuna(l.coluna_id) || 'Sem série'))
      : dim === 'origem' ? (l.origem || 'Sem origem') : nomeUsuario(l.responsavel_id)
    const g: Record<string, number> = {}
    for (const l of matricLeads) { const k = chave(l); g[k] = (g[k] || 0) + 1 }
    const tabela: Row[] = Object.entries(g).map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd)
    const totalAlunos = matricLeads.length

    const ini = inicioPeriodo(periodo)
    const opMap: Record<string, { nome: string; matriculas: number; tarefas: number; contatos: number }> = {}
    const op = (id: string | null) => { const k = id || 'sem'; if (!opMap[k]) opMap[k] = { nome: nomeUsuario(id), matriculas: 0, tarefas: 0, contatos: 0 }; return opMap[k] }
    for (const l of ls) {
      if (new Date(l.criado_em).getTime() >= ini) op(l.responsavel_id).contatos++
    }
    for (const l of matricLeads) {
      if (new Date(l.entrou_coluna_em || l.criado_em).getTime() >= ini) op(l.responsavel_id).matriculas++
    }
    for (const t of ts) { if (new Date(t.criado_em).getTime() >= ini) op(t.responsavel_id).tarefas++ }
    const operadores = Object.values(opMap)
    if (operadores.length === 0) operadores.push({ nome: nomeUser ? cap(nomeUser) : 'Operador', matriculas: 0, tarefas: 0, contatos: 0 })

    const funilOrdenado = [...cols].sort((a, b) => (a.ordem || 0) - (b.ordem || 0))
    // A coluna "Matriculados" da captação fica vazia (os leads vão para o funil dedicado);
    // por isso mostramos ali a contagem real de matriculados.
    const funil = funilOrdenado.map((c) => ({ nome: c.nome, qtd: /matric/i.test(c.nome) ? matricLeads.length : ls.filter((l) => l.coluna_id === c.id).length }))
    const totalLeads = ls.length + matricLeads.length
    const qtdPor = (re: RegExp) => funil.find((c) => re.test(c.nome))?.qtd || 0
    const matriculados = matricLeads.length
    const perdidos = qtdPor(/perdid/i)
    const visitaAgendada = qtdPor(/agendada/i)
    const visitaRealizada = qtdPor(/realizada/i)
    const taxaMatricula = totalLeads > 0 ? (matriculados / totalLeads) * 100 : 0
    const maxFunil = Math.max(1, ...funil.map((c) => c.qtd))

    // Aquisição por canal (mês atual) + CAC
    const periodoAtual = (() => { const x = new Date(); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}` })()
    const canalMap: Record<string, { canal: string; leads: number; matriculas: number; investimento: number }> = {}
    const canalDe = (l: any) => l.familia?.canal || 'organico'
    for (const l of ls) {
      const c = canalDe(l)
      if (!canalMap[c]) canalMap[c] = { canal: c, leads: 0, matriculas: 0, investimento: 0 }
      if (new Date(l.criado_em).getTime() >= iniMes) canalMap[c].leads++
    }
    for (const l of matricLeads) {
      const c = canalDe(l)
      if (!canalMap[c]) canalMap[c] = { canal: c, leads: 0, matriculas: 0, investimento: 0 }
      if (new Date(l.entrou_coluna_em || l.criado_em).getTime() >= iniMes) canalMap[c].matriculas++
    }
    for (const inv of invs) {
      if (inv.periodo === periodoAtual) {
        const c = inv.canal
        if (!canalMap[c]) canalMap[c] = { canal: c, leads: 0, matriculas: 0, investimento: 0 }
        canalMap[c].investimento += Number(inv.valor) || 0
      }
    }
    const aquisicao = Object.values(canalMap).sort((a, b) => b.leads - a.leads)

    return {
      contatosTotal: ls.length, contatosMes, metaContatos: somaMeta(/contato/i),
      matriculasTotal: matricLeads.length, matriculasMes, metaMatriculas: somaMeta(/matr[ií]c/i),
      tabela, totalAlunos, operadores,
      funil, totalLeads, matriculados, perdidos, visitaAgendada, visitaRealizada, taxaMatricula, maxFunil,
      aquisicao,
    }
  }, [colunas, leads, tarefas, metas, usuarios, funis, funilSel, dim, periodo, nomeUser, invs])

  function previsao(r: number) {
    const h = new Date(); const dia = h.getDate()
    const dm = new Date(h.getFullYear(), h.getMonth() + 1, 0).getDate()
    return dia > 0 ? Math.round((r / dia) * dm) : r
  }
  const pct = (p: number, m: number) => m > 0 ? ((p / m) * 100).toFixed(2).replace('.', ',') : '0,00'
  const mesAno = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

  return (
    <div className="min-h-screen flex flex-col bg-[#EEF2FF]">
      <Topbar />
      <div className="mx-auto w-full max-w-5xl p-6">
        <h1 className="text-2xl font-bold text-slate-900">Bem-vindo(a){nomeUser ? `, ${cap(nomeUser)}` : ''}!</h1>
        <p className="mb-5 text-sm text-slate-500">Desde seu último acesso, estes foram os principais acontecimentos que podem interessá-lo(a):</p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="space-y-5">
            <div className="flex gap-4 overflow-x-auto pb-1">
              <KpiCard noun="novas matrículas" meta={d.metaMatriculas} realizado={d.matriculasMes} prev={previsao(d.matriculasMes)} pct={pct(previsao(d.matriculasMes), d.metaMatriculas)} total={d.matriculasTotal} />
              <KpiCard noun="novos contatos" meta={d.metaContatos} realizado={d.contatosMes} prev={previsao(d.contatosMes)} pct={pct(previsao(d.contatosMes), d.metaContatos)} total={d.contatosTotal} />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="mb-1 font-bold text-slate-900">Funil de conversão</h2>
              <p className="mb-4 text-xs text-slate-500">Distribuição atual dos leads por etapa e efetividade do follow-up automático.</p>

              <div className="mb-5 grid gap-3 sm:grid-cols-3">
                <StatBox label="Taxa de matrícula" valor={`${d.taxaMatricula.toFixed(1).replace('.', ',')}%`} sub={`${d.matriculados} de ${d.totalLeads} leads`} />
                <StatBox label="Em visita" valor={`${d.visitaAgendada + d.visitaRealizada}`} sub={`${d.visitaAgendada} agendadas · ${d.visitaRealizada} realizadas`} />
                <StatBox label="Perdidos" valor={`${d.perdidos}`} sub={d.totalLeads > 0 ? `${Math.round((d.perdidos / d.totalLeads) * 100)}% do total` : '—'} />
              </div>

              <div className="space-y-2">
                {d.funil.map((c) => (
                  <div key={c.nome} className="flex items-center gap-3">
                    <span className="w-36 truncate text-sm text-slate-700">{c.nome}</span>
                    <div className="flex-1"><div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className="h-2.5 rounded-full bg-indigo-500" style={{ width: `${(c.qtd / d.maxFunil) * 100}%` }} /></div></div>
                    <span className="w-8 text-right text-sm font-medium text-slate-600">{c.qtd}</span>
                  </div>
                ))}
              </div>

              {fstats && (
                <div className="mt-5 rounded-lg bg-indigo-50 p-4">
                  <div className="mb-3 text-sm font-semibold text-indigo-900">Efetividade do follow-up automático</div>
                  <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                    <FollowStat label="Enviados" v={fstats.enviados} />
                    <FollowStat label="Leads alcançados" v={fstats.leads_alcancados} />
                    <FollowStat label="Responderam" v={fstats.leads_responderam} />
                    <FollowStat label="Taxa de resposta" v={fstats.leads_alcancados > 0 ? `${Math.round((fstats.leads_responderam / fstats.leads_alcancados) * 100)}%` : '—'} />
                  </div>
                  {fstats.falhas > 0 && <div className="mt-2 text-center text-xs text-amber-700">{fstats.falhas} envio(s) falharam</div>}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="font-bold text-slate-900">Aquisição por canal (mês atual)</h2>
                <Link href="/configuracoes/investimento" className="text-xs font-medium text-blue-600 hover:underline">Lançar investimento</Link>
              </div>
              <p className="mb-4 text-xs text-slate-500">CAC = investimento ÷ matrículas do canal no mês.</p>
              {d.aquisicao.length === 0 ? (
                <p className="text-sm text-slate-400">Sem leads ainda neste mês.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase text-slate-400">
                        <th className="py-2 pr-3">Canal</th>
                        <th className="py-2 px-3 text-right">Leads</th>
                        <th className="py-2 px-3 text-right">Matrículas</th>
                        <th className="py-2 px-3 text-right">Investimento</th>
                        <th className="py-2 px-3 text-right">Custo/lead</th>
                        <th className="py-2 pl-3 text-right">CAC</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {d.aquisicao.map((a) => (
                        <tr key={a.canal}>
                          <td className="py-2 pr-3 font-medium text-slate-700">{a.canal}</td>
                          <td className="py-2 px-3 text-right text-slate-600">{a.leads}</td>
                          <td className="py-2 px-3 text-right text-slate-600">{a.matriculas}</td>
                          <td className="py-2 px-3 text-right text-slate-600">{a.investimento > 0 ? brl(a.investimento) : '—'}</td>
                          <td className="py-2 px-3 text-right text-slate-600">{a.leads > 0 && a.investimento > 0 ? brl(a.investimento / a.leads) : '—'}</td>
                          <td className="py-2 pl-3 text-right font-semibold text-slate-900">{a.matriculas > 0 && a.investimento > 0 ? brl(a.investimento / a.matriculas) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <a className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-blue-600 hover:underline">
              <LineChart className="h-4 w-4" /> Analisar Gráficos
            </a>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="mb-3 font-bold text-slate-900">Acompanhamento das matrículas</h2>
              <div className="mb-2 flex gap-2 text-sm">
                {(['serie', 'origem', 'dono'] as const).map((k) => (
                  <button key={k} onClick={() => setDim(k)} className={`rounded-lg px-3 py-1 font-semibold ${dim === k ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50'}`}>
                    {k === 'serie' ? 'Série' : k === 'origem' ? 'Origem' : 'Dono'}
                  </button>
                ))}
              </div>
              {d.tabela.length === 0 ? <p className="py-3 text-sm text-slate-400">Nenhuma matrícula ainda.</p> : (
                <div className="divide-y divide-slate-100">
                  {d.tabela.map((r) => {
                    const p = d.totalAlunos > 0 ? Math.round((r.qtd / d.totalAlunos) * 100) : 0
                    return (
                      <div key={r.nome} className="flex items-center gap-3 py-2.5">
                        <span className="w-40 truncate text-sm text-slate-700">{r.nome}</span>
                        <div className="flex-1"><div className="h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-2 rounded-full bg-blue-600" style={{ width: `${p}%` }} /></div></div>
                        <span className="w-20 text-right text-sm text-slate-600">{r.qtd} ({p}%)</span>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="mt-3 text-sm font-semibold text-slate-700">Total de alunos: {d.totalAlunos}</div>
            </div>

            <div className="rounded-xl bg-[#E8EEF9] p-5">
              <h2 className="mb-3 font-bold text-slate-900">Acompanhamento de operadores</h2>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <button onClick={() => setPeriodo('hoje')} className={`rounded-lg border px-3 py-1 text-sm ${periodo === 'hoje' ? 'border-blue-500 bg-white text-blue-700' : 'border-slate-300 bg-white text-slate-700'}`}>Hoje</button>
                <div className="flex items-center gap-1 text-slate-400"><ChevronLeft className="h-4 w-4" /><span className="text-sm font-bold capitalize text-blue-700">{mesAno}</span><ChevronRight className="h-4 w-4" /></div>
                <div className="flex gap-3 text-sm">
                  {[['semana', 'Semanal'], ['mes', 'Mensal'], ['ano', 'Anual']].map(([v, l]) => (
                    <button key={v} onClick={() => setPeriodo(v)} className={`font-medium ${periodo === v ? 'text-blue-700' : 'text-slate-500 hover:text-slate-700'}`}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {d.operadores.map((o, i) => (
                  <div key={i} className="rounded-xl bg-white p-4">
                    <div className="mb-3 flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">{o.nome.slice(0, 2).toUpperCase()}</div>
                      <span className="text-sm font-medium text-slate-800">{o.nome}</span>
                    </div>
                    <div className="divide-y divide-slate-100 text-sm">
                      <MetricRow label="Matrículas realizadas" v={o.matriculas} />
                      <MetricRow label="Tarefas cadastradas" v={o.tarefas} />
                      <MetricRow label="Número de novos contatos" v={o.contatos} />
                    </div>
                    <a className="mt-3 inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-blue-600 hover:underline">Aprofundar casos trabalhados <ArrowRight className="h-3.5 w-3.5" /></a>
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

function KpiCard({ noun, meta, realizado, prev, pct, total }: { noun: string; meta: number; realizado: number; prev: number; pct: string; total: number }) {
  return (
    <div className="min-w-[340px] flex-1 rounded-xl border border-blue-100 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-slate-900">Número de <span className="text-blue-600">{noun}</span></h3>
      <div className="flex items-stretch">
        <div className="flex-1">
          <div className="mb-2 text-xs font-semibold text-blue-600">Mensal</div>
          <div className="grid grid-cols-3 gap-2">
            <div><div className="text-[10px] uppercase text-slate-400">Meta</div><div className="text-3xl font-bold text-slate-900">{meta}</div></div>
            <div><div className="text-[10px] uppercase text-slate-400">Realizado</div><div className="text-3xl font-bold text-slate-900">{realizado}</div></div>
            <div><div className="text-[10px] uppercase text-slate-400">Previsão</div><div className="text-3xl font-bold text-red-600">{prev}</div><div className="text-[11px] font-medium text-red-600">({pct}%)</div></div>
          </div>
        </div>
        <div className="mx-4 w-px bg-slate-200" />
        <div className="flex flex-col justify-start">
          <div className="mb-2 text-xs font-semibold text-blue-600">Funil Total</div>
          <div className="text-3xl font-bold text-slate-900">{total}</div>
        </div>
      </div>
    </div>
  )
}

function MetricRow({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-slate-600">{label}</span>
      <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800">{v}</span>
    </div>
  )
}

function StatBox({ label, valor, sub }: { label: string; valor: string; sub: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-2xl font-bold text-slate-900">{valor}</div>
      <div className="text-xs text-slate-500">{sub}</div>
    </div>
  )
}

function FollowStat({ label, v }: { label: string; v: number | string }) {
  return (
    <div>
      <div className="text-xl font-bold text-indigo-900">{v}</div>
      <div className="text-[11px] text-indigo-700/70">{label}</div>
    </div>
  )
}
