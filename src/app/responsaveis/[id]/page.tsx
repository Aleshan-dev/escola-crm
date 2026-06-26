'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, MessageSquare, CalendarPlus, FileText, Loader2, Plus } from 'lucide-react'

type Crianca = { id: string; nome: string }
type ColunaRef = { nome: string; cor: string }
type Lead = { id: string; coluna_id: string; colunas: ColunaRef | null }
type Familia = {
  id: string
  nome_responsavel: string
  telefone: string | null
  email: string | null
  cpf: string | null
  rg: string | null
  tipo_responsavel: string | null
  cep: string | null
  rua: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  cidade: string | null
  estado: string | null
  pais: string | null
  criancas: Crianca[]
  leads: Lead[]
}
type Evento = { id: string; categoria: 'tarefa' | 'anotacao' | 'conversa' | 'funil' | 'visita'; texto: string; quando: string; concluida?: boolean }

const TABS = [
  { v: 'tudo', label: 'Tudo' },
  { v: 'tarefa', label: 'Tarefas' },
  { v: 'anotacao', label: 'Anotações' },
  { v: 'funil', label: 'Ações no funil' },
  { v: 'conversa', label: 'Conversas' },
  { v: 'visita', label: 'Visitas' },
]
const TIPOS_T = ['visita', 'ligacao', 'followup', 'reuniao', 'geral']
const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

function catLabel(c: string): string {
  return c === 'tarefa' ? 'Tarefa' : c === 'anotacao' ? 'Anotação' : c === 'conversa' ? 'Conversa' : c === 'visita' ? 'Visita' : 'Funil'
}
function catCor(c: string): string {
  return c === 'tarefa' ? 'bg-blue-100 text-blue-700' : c === 'anotacao' ? 'bg-amber-100 text-amber-700' : c === 'conversa' ? 'bg-slate-100 text-slate-600' : c === 'visita' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'
}

function Campo({ label, valor, onSave }: { label: string; valor: string | null; onSave: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-xs text-slate-500 flex-shrink-0">{label}</span>
      <input defaultValue={valor || ''} onBlur={(e) => onSave(e.target.value)} placeholder="—" className="text-sm text-slate-700 text-right outline-none bg-transparent w-40 focus:text-slate-900" />
    </div>
  )
}

export default function ResponsavelDetalhePage() {
  const params = useParams()
  const id = String(params.id)
  const supabase = createClient()

  const [loading, setLoading] = useState(true)
  const [f, setF] = useState<Familia | null>(null)
  const [eventos, setEventos] = useState<Evento[]>([])
  const [aba, setAba] = useState('tudo')

  const [novaTarefa, setNovaTarefa] = useState(false)
  const [tTitulo, setTTitulo] = useState('')
  const [tTipo, setTTipo] = useState('visita')
  const [tData, setTData] = useState('')
  const [novaAnot, setNovaAnot] = useState(false)
  const [anotTxt, setAnotTxt] = useState('')

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('familias')
      .select('*, criancas(id, nome), leads(id, coluna_id, colunas(nome, cor))')
      .eq('id', id)
      .maybeSingle()
    const fam = data as unknown as Familia | null
    setF(fam)

    const leadIds = (fam?.leads || []).map((l) => l.id)
    if (leadIds.length) {
      const [an, ta, ms, ac] = await Promise.all([
        supabase.from('anotacoes').select('id, conteudo, criado_em').in('lead_id', leadIds),
        supabase.from('tarefas').select('id, titulo, tipo, data_hora, concluida').in('lead_id', leadIds),
        supabase.from('mensagens').select('id, direcao, conteudo, criado_em').in('lead_id', leadIds),
        supabase.from('acoes_sara').select('id, tipo, razao, criado_em').in('lead_id', leadIds),
      ])
      const evs: Evento[] = []
      for (const a of (an.data as unknown as { id: string; conteudo: string; criado_em: string }[]) || []) evs.push({ id: 'an' + a.id, categoria: 'anotacao', texto: a.conteudo, quando: a.criado_em })
      for (const t of (ta.data as unknown as { id: string; titulo: string; tipo: string | null; data_hora: string; concluida: boolean }[]) || []) evs.push({ id: 'ta' + t.id, categoria: t.tipo === 'visita' ? 'visita' : 'tarefa', texto: t.titulo, quando: t.data_hora, concluida: t.concluida })
      for (const m of (ms.data as unknown as { id: string; direcao: string; conteudo: string; criado_em: string }[]) || []) evs.push({ id: 'ms' + m.id, categoria: 'conversa', texto: (m.direcao === 'in' ? '← ' : '→ ') + m.conteudo, quando: m.criado_em })
      for (const a of (ac.data as unknown as { id: string; tipo: string; razao: string | null; criado_em: string }[]) || []) evs.push({ id: 'ac' + a.id, categoria: 'funil', texto: a.razao || ('Sara: ' + a.tipo), quando: a.criado_em })
      evs.sort((x, y) => new Date(y.quando).getTime() - new Date(x.quando).getTime())
      setEventos(evs)
    } else {
      setEventos([])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function salvar(campo: string, valor: string) {
    await supabase.from('familias').update({ [campo]: valor || null }).eq('id', id)
  }

  const lead = f?.leads?.[0]
  const pendencias = eventos.filter((e) => (e.categoria === 'tarefa' || e.categoria === 'visita') && e.concluida === false).length

  const eventosFiltrados = useMemo(() => {
    if (aba === 'tudo') return eventos
    return eventos.filter((e) => e.categoria === aba)
  }, [eventos, aba])

  async function addTarefa() {
    if (!tTitulo.trim() || !tData || !lead) return
    await supabase.from('tarefas').insert({ lead_id: lead.id, titulo: tTitulo.trim(), tipo: tTipo, data_hora: new Date(tData).toISOString() })
    setTTitulo(''); setTData(''); setNovaTarefa(false); load()
  }
  async function addAnot() {
    if (!anotTxt.trim() || !lead) return
    await supabase.from('anotacoes').insert({ lead_id: lead.id, conteudo: anotTxt.trim() })
    setAnotTxt(''); setNovaAnot(false); load()
  }

  if (loading) return (<div className="min-h-screen flex flex-col bg-slate-50"><Topbar /><div className="p-8 text-slate-500 flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div></div>)
  if (!f) return (<div className="min-h-screen flex flex-col bg-slate-50"><Topbar /><div className="p-8 text-slate-500">Responsável não encontrado.</div></div>)

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-4">
        <Link href="/responsaveis" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Responsáveis</Link>

        <div className="grid lg:grid-cols-[320px_1fr] gap-4">
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-semibold">{(f.nome_responsavel || '?').slice(0, 2).toUpperCase()}</div>
                <input defaultValue={f.nome_responsavel} onBlur={(e) => salvar('nome_responsavel', e.target.value)} className="flex-1 text-base font-semibold outline-none border-b border-transparent focus:border-slate-300" />
              </div>
              {f.criancas.length > 0 && <div className="text-sm text-slate-600 mb-1">Aluno(s): {f.criancas.map((c) => c.nome).join(', ')}</div>}
              {lead?.colunas && <span className="inline-block text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: '#eff6ff', color: lead.colunas.cor }}>{lead.colunas.nome}</span>}

              <div className="grid grid-cols-3 gap-2 mt-4">
                {lead && <Link href={`/chat?lead=${lead.id}`} className="flex flex-col items-center gap-1 rounded-lg border border-slate-200 py-2 text-[11px] text-slate-600 hover:bg-slate-50"><MessageSquare className="w-4 h-4 text-green-600" />WhatsApp</Link>}
                <button onClick={() => { setAba('tarefa'); setNovaTarefa(true) }} className="flex flex-col items-center gap-1 rounded-lg border border-slate-200 py-2 text-[11px] text-slate-600 hover:bg-slate-50"><CalendarPlus className="w-4 h-4 text-blue-600" />Tarefa</button>
                <button onClick={() => { setAba('anotacao'); setNovaAnot(true) }} className="flex flex-col items-center gap-1 rounded-lg border border-slate-200 py-2 text-[11px] text-slate-600 hover:bg-slate-50"><FileText className="w-4 h-4 text-amber-600" />Anotação</button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500 uppercase mb-3">Dados do responsável</div>
              <Campo label="CPF" valor={f.cpf} onSave={(v) => salvar('cpf', v)} />
              <Campo label="Celular" valor={f.telefone} onSave={(v) => salvar('telefone', v)} />
              <Campo label="E-mail" valor={f.email} onSave={(v) => salvar('email', v)} />
              <Campo label="RG" valor={f.rg} onSave={(v) => salvar('rg', v)} />
              <Campo label="Tipo" valor={f.tipo_responsavel} onSave={(v) => salvar('tipo_responsavel', v)} />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold text-slate-500 uppercase mb-3">Endereço</div>
              <Campo label="CEP" valor={f.cep} onSave={(v) => salvar('cep', v)} />
              <Campo label="Rua" valor={f.rua} onSave={(v) => salvar('rua', v)} />
              <Campo label="Número" valor={f.numero} onSave={(v) => salvar('numero', v)} />
              <Campo label="Complemento" valor={f.complemento} onSave={(v) => salvar('complemento', v)} />
              <Campo label="Bairro" valor={f.bairro} onSave={(v) => salvar('bairro', v)} />
              <Campo label="Cidade" valor={f.cidade} onSave={(v) => salvar('cidade', v)} />
              <Campo label="Estado" valor={f.estado} onSave={(v) => salvar('estado', v)} />
              <Campo label="País" valor={f.pais} onSave={(v) => salvar('pais', v)} />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Pendências</span>
                <span className="text-sm font-semibold text-blue-600">{pendencias}</span>
              </div>
              <button onClick={() => { setAba('tarefa'); setNovaTarefa(true) }} className="mt-3 w-full rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">Criar nova tarefa</button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="text-lg font-semibold mb-3">Histórico</div>
            <div className="flex flex-wrap gap-1.5 border-b border-slate-100 pb-3 mb-3">
              {TABS.map((t) => (
                <button key={t.v} onClick={() => setAba(t.v)} className={`text-xs px-3 py-1.5 rounded-lg font-medium ${aba === t.v ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50'}`}>{t.label}</button>
              ))}
            </div>

            <div className="flex gap-2 mb-4">
              <button onClick={() => { setNovaTarefa((v) => !v); setNovaAnot(false) }} className="inline-flex items-center gap-1 text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"><Plus className="w-3.5 h-3.5" /> Tarefa</button>
              <button onClick={() => { setNovaAnot((v) => !v); setNovaTarefa(false) }} className="inline-flex items-center gap-1 text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"><Plus className="w-3.5 h-3.5" /> Anotação</button>
            </div>

            {novaTarefa && (
              <div className="rounded-lg bg-slate-50 p-3 mb-4 space-y-2">
                <input value={tTitulo} onChange={(e) => setTTitulo(e.target.value)} placeholder="Título da tarefa" className={inputCls} />
                <div className="grid grid-cols-[auto_1fr_auto] gap-2">
                  <select value={tTipo} onChange={(e) => setTTipo(e.target.value)} className={inputCls}>{TIPOS_T.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                  <input type="datetime-local" value={tData} onChange={(e) => setTData(e.target.value)} className={inputCls} />
                  <button onClick={addTarefa} className="rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700">Salvar</button>
                </div>
              </div>
            )}
            {novaAnot && (
              <div className="rounded-lg bg-slate-50 p-3 mb-4 space-y-2">
                <textarea value={anotTxt} onChange={(e) => setAnotTxt(e.target.value)} rows={2} placeholder="Escreva uma anotação..." className={inputCls} />
                <button onClick={addAnot} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">Salvar anotação</button>
              </div>
            )}

            {eventosFiltrados.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhum registro.</p>
            ) : (
              <div className="space-y-2">
                {eventosFiltrados.map((e) => (
                  <div key={e.id} className="rounded-lg border border-slate-100 p-3">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${catCor(e.categoria)}`}>{catLabel(e.categoria)}</span>
                      <span className="text-[10px] text-slate-400">{new Date(e.quando).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className={`text-sm ${e.concluida ? 'line-through text-slate-400' : 'text-slate-700'}`}>{e.texto}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
