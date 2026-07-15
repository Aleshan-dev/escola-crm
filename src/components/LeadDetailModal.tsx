'use client'

import { useEffect, useState } from 'react'
import type { Coluna, Lead } from '@/lib/types'
import { createClient } from '@/lib/supabase-browser'
import { X, Bot, MessageSquare, Phone, Mail, Baby, FileText, CheckSquare, Square, Trash2, Plus, ListChecks, CheckCircle2, Circle } from 'lucide-react'
import Link from 'next/link'

function diasNaEtapa(entrou: string): number {
  const ms = Date.now() - new Date(entrou).getTime()
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)))
}

type Serie = { id: string; nome: string }
type CriancaRow = { id: string; nome: string; idade: number | null; serie_desejada: string | null; periodo: string | null }
type Tarefa = { id: string; titulo: string; tipo: string | null; data_hora: string; concluida: boolean }
type Anotacao = { id: string; conteudo: string; criado_em: string }

const TIPOS = ['geral', 'visita', 'ligacao', 'followup', 'reuniao']
const selCls = 'rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-blue-400 bg-white'
const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

export function LeadDetailModal({
  lead,
  colunas,
  funis = [],
  onClose,
}: {
  lead: Lead
  colunas: Coluna[]
  funis?: { id: string; nome: string }[]
  onClose: () => void
}) {
  const supabase = createClient()
  const dias = diasNaEtapa(lead.entrou_coluna_em)

  const [colunaId, setColunaId] = useState(lead.coluna_id)
  const colAtual = colunas.find((c) => c.id === lead.coluna_id)
  const [funilId, setFunilId] = useState(colAtual?.funil_id || funis[0]?.id || '')
  const colunasDoFunil = colunas.filter((c) => c.funil_id === funilId).sort((a, b) => a.ordem - b.ordem)
  const [temperatura, setTemperatura] = useState<string>(lead.temperatura)
  const [criancasLista, setCriancasLista] = useState<CriancaRow[]>([])

  // Checklist de atendimento (campos do lead + cidade da família)
  const L = lead as any
  const [escolaAtual, setEscolaAtual] = useState<string>(L.escola_atual || '')
  const [primeiraExp, setPrimeiraExp] = useState<string>(L.primeira_experiencia || '')
  const [motivoBusca, setMotivoBusca] = useState<string>(L.motivo_busca || '')
  const [quandoIniciar, setQuandoIniciar] = useState<string>(L.quando_iniciar || '')
  const [cidade, setCidade] = useState<string>((lead.familia as any)?.cidade || '')

  const [seriesList, setSeriesList] = useState<Serie[]>([])
  const [turnosList, setTurnosList] = useState<{ nome: string }[]>([])
  const [tarefas, setTarefas] = useState<Tarefa[]>([])
  const [anotacoes, setAnotacoes] = useState<Anotacao[]>([])

  const [tTitulo, setTTitulo] = useState('')
  const [tTipo, setTTipo] = useState('visita')
  const [tData, setTData] = useState('')
  const [tErro, setTErro] = useState<string | null>(null)

  const [novaAnotacao, setNovaAnotacao] = useState('')
  const [salvandoAnot, setSalvandoAnot] = useState(false)

  const [saraLoading, setSaraLoading] = useState(false)
  const [saraMsg, setSaraMsg] = useState<string | null>(null)

  async function saraResponder() {
    if (saraLoading) return
    setSaraLoading(true); setSaraMsg(null)
    try {
      const r = await fetch('/api/sara/responder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id }),
      })
      const j = await r.json()
      setSaraMsg(j?.ok ? 'Sara respondeu ✓' : `Falha: ${j?.error || 'erro'}`)
    } catch {
      setSaraMsg('Falha ao acionar a Sara.')
    } finally {
      setSaraLoading(false)
    }
  }

  async function carregarTarefas() {
    const { data } = await supabase
      .from('tarefas')
      .select('id, titulo, tipo, data_hora, concluida')
      .eq('lead_id', lead.id)
      .order('data_hora')
    setTarefas((data as unknown as Tarefa[]) || [])
  }

  async function carregarAnotacoes() {
    const { data } = await supabase
      .from('anotacoes')
      .select('id, conteudo, criado_em')
      .eq('lead_id', lead.id)
      .order('criado_em', { ascending: false })
    setAnotacoes((data as unknown as Anotacao[]) || [])
  }

  async function addAnotacao() {
    const texto = novaAnotacao.trim()
    if (!texto || salvandoAnot) return
    setSalvandoAnot(true)
    const { error } = await supabase.from('anotacoes').insert({ lead_id: lead.id, conteudo: texto })
    setSalvandoAnot(false)
    if (!error) {
      setNovaAnotacao('')
      carregarAnotacoes()
    }
  }

  useEffect(() => {
    let ativo = true
    supabase.from('series').select('id, nome').eq('ativa', true).order('ordem').then(({ data }) => {
      if (ativo && data) setSeriesList(data as unknown as Serie[])
    })
    supabase.from('turnos').select('nome').eq('ativo', true).order('ordem').then(({ data }) => {
      if (ativo && data) setTurnosList(data as unknown as { nome: string }[])
    })
    carregarAnotacoes()
    carregarTarefas()
    carregarCriancas()
    return () => { ativo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id])

  async function mudarColuna(id: string) {
    setColunaId(id)
    await supabase.from('leads').update({ coluna_id: id, entrou_coluna_em: new Date().toISOString() }).eq('id', lead.id)
    const nomeCol = colunas.find((c) => c.id === id)?.nome || ''
    if (/matric|perdid/i.test(nomeCol)) {
      fetch('/api/notificar-desfecho', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: lead.id, coluna: nomeCol }),
      }).catch(() => {})
    }
  }
  // Transferência manual de funil: move o lead para a primeira etapa do funil escolhido.
  async function mudarFunil(nf: string) {
    setFunilId(nf)
    const primeira = colunas.filter((c) => c.funil_id === nf).sort((a, b) => a.ordem - b.ordem)[0]
    if (primeira && primeira.id !== colunaId) await mudarColuna(primeira.id)
  }
  async function mudarTemperatura(t: string) {
    if (t === 'auto') {
      // Volta ao cálculo automático: remove override e recalcula no banco
      await supabase.from('leads').update({ temperatura_manual: false }).eq('id', lead.id)
      const { data } = await supabase.from('leads').select('temperatura').eq('id', lead.id).single()
      if (data?.temperatura) setTemperatura(data.temperatura as string)
      return
    }
    setTemperatura(t)
    // Ajuste manual: marca override para o cálculo automático não sobrescrever
    await supabase.from('leads').update({ temperatura: t, temperatura_manual: true }).eq('id', lead.id)
  }
  async function salvarLeadCampo(campos: Record<string, any>) {
    await supabase.from('leads').update(campos).eq('id', lead.id)
  }
  async function salvarCidade(v: string) {
    if (lead.familia_id) await supabase.from('familias').update({ cidade: v || null }).eq('id', lead.familia_id)
  }
  async function carregarCriancas() {
    if (!lead.familia_id) return
    const { data } = await supabase
      .from('criancas')
      .select('id, nome, idade, serie_desejada, periodo')
      .eq('familia_id', lead.familia_id)
      .order('criado_em')
    setCriancasLista((data as unknown as CriancaRow[]) || [])
  }
  // Atualiza só o estado local (enquanto digita), sem gravar no banco.
  function editarCriancaLocal(id: string, campos: Partial<CriancaRow>) {
    setCriancasLista((prev) => prev.map((c) => (c.id === id ? { ...c, ...campos } : c)))
  }
  async function atualizarCrianca(id: string, campos: Partial<CriancaRow>) {
    setCriancasLista((prev) => prev.map((c) => (c.id === id ? { ...c, ...campos } : c)))
    await supabase.from('criancas').update(campos).eq('id', id)
  }
  async function addCrianca() {
    if (!lead.familia_id) return
    const { data } = await supabase
      .from('criancas')
      .insert({ familia_id: lead.familia_id, nome: '' })
      .select('id, nome, idade, serie_desejada, periodo')
      .single()
    if (data) setCriancasLista((prev) => [...prev, data as unknown as CriancaRow])
  }
  async function removerCrianca(id: string) {
    await supabase.from('criancas').delete().eq('id', id)
    const resto = criancasLista.filter((c) => c.id !== id)
    setCriancasLista(resto)
    if (lead.crianca_id === id) {
      await supabase.from('leads').update({ crianca_id: resto[0]?.id ?? null }).eq('id', lead.id)
    }
  }

  async function addTarefa() {
    setTErro(null)
    if (!tTitulo.trim()) { setTErro('Informe o título.'); return }
    if (!tData) { setTErro('Informe a data e hora.'); return }
    const { error } = await supabase.from('tarefas').insert({
      lead_id: lead.id,
      titulo: tTitulo.trim(),
      tipo: tTipo,
      data_hora: new Date(tData).toISOString(),
    })
    if (error) { setTErro(error.message); return }
    setTTitulo(''); setTData(''); carregarTarefas()
  }
  async function toggleTarefa(t: Tarefa) {
    await supabase.from('tarefas').update({ concluida: !t.concluida }).eq('id', t.id)
    carregarTarefas()
  }
  async function removerTarefa(id: string) {
    await supabase.from('tarefas').delete().eq('id', id)
    carregarTarefas()
  }

  async function arquivarLead() {
    await supabase.from('leads').update({ arquivado: true }).eq('id', lead.id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">{lead.familia?.nome_responsavel || 'Sem nome'}</h2>
            {lead.crianca && <span className="text-xs text-slate-500">{lead.crianca.nome}</span>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Fechar"><X className="w-5 h-5" /></button>
        </div>

        <div className="space-y-5 p-5">
          <div className="grid grid-cols-2 gap-3">
            {funis.length > 1 && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Funil</span>
                <select value={funilId} onChange={(e) => mudarFunil(e.target.value)} className={`${selCls} w-full`}>
                  {funis.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                </select>
              </label>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Etapa</span>
              <select value={colunaId} onChange={(e) => mudarColuna(e.target.value)} className={`${selCls} w-full`}>
                {colunasDoFunil.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">Temperatura</span>
              <select value={temperatura} onChange={(e) => mudarTemperatura(e.target.value)} className={`${selCls} w-full`}>
                <option value="auto">Automático (recalcular)</option>
                <option value="frio">Frio</option>
                <option value="morno">Morno</option>
                <option value="quente">Quente</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">Score {lead.score}</span>
            <span className={`px-2.5 py-1 rounded-full font-medium ${dias >= 7 ? 'bg-red-100 text-red-700' : dias >= 3 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{dias === 0 ? 'Entrou hoje' : `${dias}d na etapa`}</span>
            {lead.ia_ativa && <span className="px-2.5 py-1 rounded-full bg-green-100 text-green-700 font-medium"><Bot className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />Sara ativa</span>}
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-slate-700"><Phone className="w-4 h-4 text-slate-400" />{lead.familia?.telefone || '—'}</div>
            {lead.familia?.email && <div className="flex items-center gap-2 text-slate-700"><Mail className="w-4 h-4 text-slate-400" />{lead.familia.email}</div>}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-700"><Baby className="w-4 h-4 text-slate-400" />Crianças</div>
              <button onClick={addCrianca} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"><Plus className="w-3.5 h-3.5" />Adicionar</button>
            </div>
            {criancasLista.length === 0 ? (
              <p className="text-xs text-slate-400">Nenhuma criança cadastrada.</p>
            ) : (
              <div className="space-y-2">
                {criancasLista.map((c) => (
                  <div key={c.id} className="rounded-lg border border-slate-200 p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={c.nome || ''}
                        onChange={(e) => editarCriancaLocal(c.id, { nome: e.target.value })}
                        onBlur={(e) => atualizarCrianca(c.id, { nome: e.target.value })}
                        placeholder="Nome da criança"
                        className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                      />
                      <input
                        value={c.idade ?? ''}
                        onChange={(e) => editarCriancaLocal(c.id, { idade: e.target.value ? Number(e.target.value) : null })}
                        onBlur={(e) => atualizarCrianca(c.id, { idade: e.target.value ? Number(e.target.value) : null })}
                        placeholder="Idade"
                        inputMode="numeric"
                        className="w-20 flex-shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                      />
                      <button onClick={() => removerCrianca(c.id)} className="flex-shrink-0 text-slate-400 hover:text-red-600" aria-label="Remover criança"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select value={c.serie_desejada || ''} onChange={(e) => atualizarCrianca(c.id, { serie_desejada: e.target.value || null })} className={`${selCls} w-full`}>
                        <option value="">Série —</option>
                        {seriesList.map((s) => <option key={s.id} value={s.nome}>{s.nome}</option>)}
                        {c.serie_desejada && !seriesList.some((s) => s.nome === c.serie_desejada) && <option value={c.serie_desejada}>{c.serie_desejada}</option>}
                      </select>
                      <select value={c.periodo || ''} onChange={(e) => atualizarCrianca(c.id, { periodo: e.target.value || null })} className={`${selCls} w-full`}>
                        <option value="">Período —</option>
                        {turnosList.map((t) => <option key={t.nome} value={t.nome}>{t.nome}</option>)}
                        {c.periodo && !turnosList.some((t) => t.nome === c.periodo) && <option value={c.periodo}>{c.periodo}</option>}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Checklist de atendimento */}
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-700"><ListChecks className="w-4 h-4 text-slate-400" />Checklist de atendimento</div>
            <div className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1">
              {[
                { label: 'Nome da criança', ok: criancasLista.some((c) => (c.nome || '').trim()) },
                { label: 'Idade', ok: criancasLista.some((c) => c.idade != null) },
                { label: 'Período', ok: criancasLista.some((c) => c.periodo) },
                { label: 'Escola atual', ok: !!escolaAtual },
                { label: 'Primeira experiência', ok: !!primeiraExp },
                { label: 'Motivo da busca', ok: !!motivoBusca },
                { label: 'Quando iniciar', ok: !!quandoIniciar },
                { label: 'Cidade', ok: !!cidade },
              ].map((it) => (
                <div key={it.label} className="flex items-center gap-1.5 text-xs">
                  {it.ok ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-green-600" /> : <Circle className="w-3.5 h-3.5 flex-shrink-0 text-slate-300" />}
                  <span className={it.ok ? 'text-slate-700' : 'text-slate-400'}>{it.label}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input value={escolaAtual} onChange={(e) => setEscolaAtual(e.target.value)} onBlur={() => salvarLeadCampo({ escola_atual: escolaAtual || null })} placeholder="Escola atual" className={inputCls} />
              <input value={primeiraExp} onChange={(e) => setPrimeiraExp(e.target.value)} onBlur={() => salvarLeadCampo({ primeira_experiencia: primeiraExp || null })} placeholder="Primeira experiência?" className={inputCls} />
              <input value={motivoBusca} onChange={(e) => setMotivoBusca(e.target.value)} onBlur={() => salvarLeadCampo({ motivo_busca: motivoBusca || null })} placeholder="Motivo da busca" className={inputCls} />
              <input value={quandoIniciar} onChange={(e) => setQuandoIniciar(e.target.value)} onBlur={() => salvarLeadCampo({ quando_iniciar: quandoIniciar || null })} placeholder="Quando pretende iniciar" className={inputCls} />
              <input value={cidade} onChange={(e) => setCidade(e.target.value)} onBlur={() => salvarCidade(cidade)} placeholder="Cidade" className={`${inputCls} col-span-2`} />
            </div>
          </div>

          {(lead.cog_intencao || lead.cog_temperatura || lead.cog_proxima_acao) && (
            <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-indigo-900">
                <Bot className="w-4 h-4" /> Leitura da Sara
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-700">
                {lead.cog_intencao && <div><span className="text-slate-400">Intenção:</span> {lead.cog_intencao}</div>}
                {lead.cog_emocao && <div><span className="text-slate-400">Emoção:</span> {lead.cog_emocao}</div>}
                {lead.cog_temperatura && <div><span className="text-slate-400">Temperatura:</span> {lead.cog_temperatura}</div>}
                {(lead.cog_interesse != null || lead.cog_urgencia != null || lead.cog_probabilidade != null) && (
                  <div><span className="text-slate-400">Score:</span> Int {lead.cog_interesse ?? '–'} · Urg {lead.cog_urgencia ?? '–'} · Prob {lead.cog_probabilidade ?? '–'}</div>
                )}
              </div>
              {lead.cog_proxima_acao && (
                <div className="mt-1.5 text-xs text-slate-700"><span className="text-slate-400">Próxima ação:</span> {lead.cog_proxima_acao}</div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2"><CheckSquare className="w-4 h-4 text-slate-400" />Tarefas</div>
            <div className="space-y-2 mb-3">
              {tarefas.length === 0 && <p className="text-xs text-slate-400">Nenhuma tarefa.</p>}
              {tarefas.map((t) => (
                <div key={t.id} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2.5">
                  <button onClick={() => toggleTarefa(t)} className="text-slate-400 hover:text-green-600">
                    {t.concluida ? <CheckSquare className="w-4 h-4 text-green-600" /> : <Square className="w-4 h-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${t.concluida ? 'line-through text-slate-400' : 'text-slate-700'}`}>{t.titulo}</p>
                    <p className="text-[10px] text-slate-400">{t.tipo} · {new Date(t.data_hora).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                  <button onClick={() => removerTarefa(t.id)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
            <div className="rounded-lg bg-slate-50 p-2.5 space-y-2">
              <input value={tTitulo} onChange={(e) => setTTitulo(e.target.value)} placeholder="Nova tarefa (ex: Ligar para confirmar visita)" className={inputCls} />
              <div className="grid grid-cols-[auto_1fr_auto] gap-2 items-center">
                <select value={tTipo} onChange={(e) => setTTipo(e.target.value)} className={selCls}>
                  {TIPOS.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                </select>
                <input type="datetime-local" value={tData} onChange={(e) => setTData(e.target.value)} className={inputCls} />
                <button onClick={addTarefa} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900"><Plus className="w-4 h-4" /></button>
              </div>
              {tErro && <p className="text-xs text-red-600">{tErro}</p>}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2"><FileText className="w-4 h-4 text-slate-400" />Anotações</div>
            {anotacoes.length === 0 ? (
              <p className="text-xs text-slate-400 mb-3">Nenhuma anotação ainda.</p>
            ) : (
              <div className="space-y-2 mb-3">
                {anotacoes.map((a) => (
                  <div key={a.id} className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{a.conteudo}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{new Date(a.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-lg bg-slate-50 p-2.5 space-y-2">
              <textarea
                value={novaAnotacao}
                onChange={(e) => setNovaAnotacao(e.target.value)}
                placeholder="Nova anotação (ex: Atendi por ligação em 01/07 — pediu proposta por e-mail, decide semana que vem)"
                rows={3}
                className={`${inputCls} resize-y`}
              />
              <div className="flex justify-end">
                <button
                  onClick={addAnotacao}
                  disabled={salvandoAnot || !novaAnotacao.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" /> Adicionar anotação
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-100 p-4 space-y-2">
          {lead.ia_ativa && (
            <>
              <button
                onClick={saraResponder}
                disabled={saraLoading}
                className="flex items-center justify-center gap-2 w-full rounded-lg bg-green-600 text-white text-sm font-medium py-2.5 hover:bg-green-700 disabled:opacity-60"
              >
                <Bot className="w-4 h-4" />
                {saraLoading ? 'Sara respondendo...' : 'Sara responder agora'}
              </button>
              {saraMsg && <p className="text-center text-xs text-slate-600">{saraMsg}</p>}
            </>
          )}
          <Link href={`/chat?lead=${lead.id}`} className="flex items-center justify-center gap-2 w-full rounded-lg bg-blue-600 text-white text-sm font-medium py-2.5 hover:bg-blue-700">
            <MessageSquare className="w-4 h-4" />
            Abrir conversa
          </Link>
          <button onClick={arquivarLead} className="w-full rounded-lg border border-slate-200 text-slate-600 text-sm font-medium py-2 hover:bg-slate-50">
            Arquivar lead
          </button>
        </div>
      </div>
    </div>
  )
}
