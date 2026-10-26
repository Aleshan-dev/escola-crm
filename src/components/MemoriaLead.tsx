'use client'

import { useEffect, useState } from 'react'
import { Brain, Pencil, Archive, Plus, Check, X } from 'lucide-react'

// Memória durável do lead (src/lib/memoria): fatos que a Sara e o Salomão lembram
// entre conversas. A equipe corrige, arquiva e adiciona por aqui (rotas
// /api/leads/[id]/memoria). Diferente das Anotações (diário livre da equipe).

type Nota = {
  id: string
  titulo: string
  corpo: string
  origem: 'sara' | 'salomao' | 'extracao' | 'equipe'
  arquivada_em: string | null
  substituida_por: string | null
  criado_em: string
  atualizado_em: string
}

const ORIGEM: Record<Nota['origem'], { rotulo: string; cls: string }> = {
  sara: { rotulo: 'Sara', cls: 'bg-pink-50 text-pink-700' },
  salomao: { rotulo: 'Salomão', cls: 'bg-indigo-50 text-indigo-700' },
  extracao: { rotulo: 'Histórico', cls: 'bg-amber-50 text-amber-700' },
  equipe: { rotulo: 'Equipe', cls: 'bg-slate-100 text-slate-700' },
}

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'
const dataCurta = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })

export function MemoriaLead({ leadId }: { leadId: string }) {
  const [notas, setNotas] = useState<Nota[]>([])
  const [ativa, setAtiva] = useState(true)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [verArquivadas, setVerArquivadas] = useState(false)

  const [editando, setEditando] = useState<string | null>(null)
  const [eTitulo, setETitulo] = useState('')
  const [eCorpo, setECorpo] = useState('')

  const [nTitulo, setNTitulo] = useState('')
  const [nCorpo, setNCorpo] = useState('')
  const [salvando, setSalvando] = useState(false)

  async function carregar() {
    const r = await fetch(`/api/leads/${leadId}/memoria`)
    const j = await r.json().catch(() => ({}))
    if (r.ok) {
      setNotas(j.notas ?? [])
      setAtiva(j.ativa !== false)
    } else setErro(j.error || 'Falha ao carregar a memória.')
    setCarregando(false)
  }

  useEffect(() => {
    carregar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId])

  async function enviar(url: string, method: string, body?: object): Promise<boolean> {
    setSalvando(true)
    setErro(null)
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const j = await r.json().catch(() => ({}))
    setSalvando(false)
    if (!r.ok) {
      setErro(j.error || 'Falha ao salvar.')
      return false
    }
    await carregar()
    return true
  }

  async function adicionar() {
    if (!nTitulo.trim()) return
    if (await enviar(`/api/leads/${leadId}/memoria`, 'POST', { titulo: nTitulo, corpo: nCorpo })) {
      setNTitulo('')
      setNCorpo('')
    }
  }

  async function salvarEdicao(id: string) {
    if (await enviar(`/api/leads/${leadId}/memoria/${id}`, 'PATCH', { titulo: eTitulo, corpo: eCorpo })) setEditando(null)
  }

  async function arquivar(id: string) {
    if (!confirm('Arquivar esta memória? A IA deixa de usá-la (fica no histórico).')) return
    await enviar(`/api/leads/${leadId}/memoria/${id}`, 'DELETE')
  }

  const ativas = notas.filter((n) => !n.arquivada_em)
  const arquivadas = notas.filter((n) => n.arquivada_em)

  return (
    <div>
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1">
        <Brain className="w-4 h-4 text-slate-400" />Memória da IA
        {!ativa && <span className="text-[10px] rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">desligada</span>}
      </div>
      <p className="text-[11px] text-slate-400 mb-2">Fatos que a Sara e o Salomão lembram entre conversas. Corrija ou arquive o que estiver errado.</p>

      {carregando ? (
        <p className="text-xs text-slate-400 mb-3">Carregando...</p>
      ) : ativas.length === 0 ? (
        <p className="text-xs text-slate-400 mb-3">Nenhuma memória ainda.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {ativas.map((n) =>
            editando === n.id ? (
              <div key={n.id} className="rounded-lg border border-blue-200 bg-white p-2.5 space-y-2">
                <input value={eTitulo} onChange={(e) => setETitulo(e.target.value)} maxLength={140} className={inputCls} />
                <textarea value={eCorpo} onChange={(e) => setECorpo(e.target.value)} maxLength={600} rows={3} className={`${inputCls} resize-y`} />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditando(null)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600"><X className="w-3.5 h-3.5" />Cancelar</button>
                  <button onClick={() => salvarEdicao(n.id)} disabled={salvando} className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"><Check className="w-3.5 h-3.5" />Salvar</button>
                </div>
              </div>
            ) : (
              <div key={n.id} className="group rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-sm font-medium text-slate-800">{n.titulo}</p>
                  <button title="Corrigir" onClick={() => { setEditando(n.id); setETitulo(n.titulo); setECorpo(n.corpo) }} className="text-slate-400 hover:text-slate-700"><Pencil className="w-3.5 h-3.5" /></button>
                  <button title="Arquivar" onClick={() => arquivar(n.id)} className="text-slate-400 hover:text-red-600"><Archive className="w-3.5 h-3.5" /></button>
                </div>
                {n.corpo && <p className="text-sm text-slate-600 whitespace-pre-wrap mt-0.5">{n.corpo}</p>}
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] rounded px-1.5 py-0.5 ${ORIGEM[n.origem].cls}`}>{ORIGEM[n.origem].rotulo}</span>
                  <span className="text-[10px] text-slate-400">{dataCurta(n.atualizado_em)}</span>
                </div>
              </div>
            )
          )}
        </div>
      )}

      <div className="rounded-lg bg-slate-50 p-2.5 space-y-2">
        <input value={nTitulo} onChange={(e) => setNTitulo(e.target.value)} maxLength={140} placeholder="Novo fato (ex: Alergia alimentar)" className={inputCls} />
        <textarea value={nCorpo} onChange={(e) => setNCorpo(e.target.value)} maxLength={600} rows={2} placeholder="Detalhe (ex: alergia a lactose, informada pela mãe em 22/10/2026)" className={`${inputCls} resize-y`} />
        <div className="flex items-center justify-between gap-2">
          {arquivadas.length > 0 ? (
            <button onClick={() => setVerArquivadas((v) => !v)} className="text-xs text-blue-600 hover:underline">
              {verArquivadas ? 'Ocultar' : 'Ver'} arquivadas ({arquivadas.length})
            </button>
          ) : <span />}
          <button onClick={adicionar} disabled={salvando || !nTitulo.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50">
            <Plus className="w-4 h-4" /> Adicionar memória
          </button>
        </div>
        {erro && <p className="text-xs text-red-600">{erro}</p>}
      </div>

      {verArquivadas && arquivadas.length > 0 && (
        <div className="space-y-1.5 mt-2">
          {arquivadas.map((n) => {
            const nova = n.substituida_por ? notas.find((x) => x.id === n.substituida_por) : null
            return (
              <div key={n.id} className="rounded-lg border border-dashed border-slate-200 p-2 opacity-70">
                <p className="text-xs text-slate-600"><b>{n.titulo}</b>{n.corpo ? `: ${n.corpo}` : ''}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {ORIGEM[n.origem].rotulo} · arquivada em {dataCurta(n.arquivada_em!)}{nova ? ` · substituída por "${nova.titulo}"` : ''}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
