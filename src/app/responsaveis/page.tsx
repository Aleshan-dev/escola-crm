'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { Search, Plus, X, Loader2 } from 'lucide-react'

type Familia = {
  id: string
  nome_responsavel: string
  telefone: string | null
  email: string | null
  criado_em: string
  criancas: { nome: string }[]
  leads: { id: string }[]
}
type TarefaMap = Record<string, { titulo: string; data_hora: string }>

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'
const PAGE = 12

export default function ResponsaveisPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [familias, setFamilias] = useState<Familia[]>([])
  const [proxTarefa, setProxTarefa] = useState<TarefaMap>({})
  const [busca, setBusca] = useState('')
  const [pagina, setPagina] = useState(0)

  const [modal, setModal] = useState(false)
  const [nome, setNome] = useState('')
  const [tel, setTel] = useState('')
  const [email, setEmail] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('familias')
      .select('id, nome_responsavel, telefone, email, criado_em, criancas(nome), leads(id)')
      .order('criado_em', { ascending: false })
    setFamilias((data as unknown as Familia[]) || [])

    const agora = new Date().toISOString()
    const { data: tdata } = await supabase
      .from('tarefas')
      .select('lead_id, titulo, data_hora')
      .eq('concluida', false)
      .gte('data_hora', agora)
      .order('data_hora')
    const map: TarefaMap = {}
    for (const t of (tdata as unknown as { lead_id: string | null; titulo: string; data_hora: string }[]) || []) {
      if (t.lead_id && !map[t.lead_id]) map[t.lead_id] = { titulo: t.titulo, data_hora: t.data_hora }
    }
    setProxTarefa(map)
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase()
    if (!q) return familias
    return familias.filter((f) =>
      (f.nome_responsavel || '').toLowerCase().includes(q) ||
      (f.telefone || '').toLowerCase().includes(q) ||
      f.criancas.some((c) => (c.nome || '').toLowerCase().includes(q))
    )
  }, [familias, busca])

  const totalPag = Math.max(1, Math.ceil(filtradas.length / PAGE))
  const pagAtual = Math.min(pagina, totalPag - 1)
  const visiveis = filtradas.slice(pagAtual * PAGE, pagAtual * PAGE + PAGE)

  function proximaTarefaDe(f: Familia): { titulo: string; data_hora: string } | null {
    for (const l of f.leads) {
      if (proxTarefa[l.id]) return proxTarefa[l.id]
    }
    return null
  }

  async function adicionar() {
    setErro(null)
    if (!nome.trim() || !tel.trim()) { setErro('Nome e celular são obrigatórios.'); return }
    setSalvando(true)
    const { error } = await supabase.from('familias').insert({ nome_responsavel: nome.trim(), telefone: tel.trim(), email: email.trim() || null })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setModal(false); setNome(''); setTel(''); setEmail(''); load()
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="flex-1 p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold">Responsáveis</h1>
          <button onClick={() => setModal(true)} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"><Plus className="w-4 h-4" /> Novo</button>
        </div>

        <div className="relative max-w-sm mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input value={busca} onChange={(e) => { setBusca(e.target.value); setPagina(0) }} placeholder="Buscar por nome, celular ou aluno..." className={`${inputCls} pl-9`} />
        </div>

        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                  <th className="px-4 py-3 font-medium">Nome do Responsável</th>
                  <th className="px-4 py-3 font-medium">Celular</th>
                  <th className="px-4 py-3 font-medium">E-mail</th>
                  <th className="px-4 py-3 font-medium">Aluno(s)</th>
                  <th className="px-4 py-3 font-medium">Próxima Tarefa</th>
                  <th className="px-4 py-3 font-medium">Criação</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500"><Loader2 className="inline w-5 h-5 animate-spin mr-2" />Carregando...</td></tr>
                ) : visiveis.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Nenhum responsável encontrado.</td></tr>
                ) : visiveis.map((f) => {
                  const pt = proximaTarefaDe(f)
                  return (
                    <tr key={f.id} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link href={`/responsaveis/${f.id}`} className="font-medium text-blue-600 hover:underline">{f.nome_responsavel}</Link>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{f.telefone || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{f.email || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{f.criancas.length ? f.criancas.map((c) => c.nome).join(', ') : '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{pt ? pt.titulo : '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{new Date(f.criado_em).toLocaleDateString('pt-BR')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!loading && filtradas.length > PAGE && (
            <div className="flex items-center justify-end gap-3 px-4 py-3 text-xs text-slate-500">
              <span>{pagAtual * PAGE + 1}–{Math.min((pagAtual + 1) * PAGE, filtradas.length)} de {filtradas.length}</span>
              <button onClick={() => setPagina(Math.max(0, pagAtual - 1))} disabled={pagAtual === 0} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40">‹</button>
              <button onClick={() => setPagina(Math.min(totalPag - 1, pagAtual + 1))} disabled={pagAtual >= totalPag - 1} className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40">›</button>
            </div>
          )}
        </div>
      </div>

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-100 p-5">
              <h2 className="text-lg font-semibold">Novo responsável</h2>
              <button onClick={() => setModal(false)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-3 p-5">
              <label className="block"><span className="mb-1 block text-xs font-medium text-slate-500">Nome *</span><input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} /></label>
              <label className="block"><span className="mb-1 block text-xs font-medium text-slate-500">Celular *</span><input value={tel} onChange={(e) => setTel(e.target.value)} className={inputCls} placeholder="5568..." /></label>
              <label className="block"><span className="mb-1 block text-xs font-medium text-slate-500">E-mail</span><input value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="opcional" /></label>
              {erro && <p className="text-sm text-red-600">{erro}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 p-4">
              <button onClick={() => setModal(false)} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
              <button onClick={adicionar} disabled={salvando} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{salvando && <Loader2 className="w-4 h-4 animate-spin" />} Criar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
