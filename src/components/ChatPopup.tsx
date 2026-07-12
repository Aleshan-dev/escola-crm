'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import type { Lead, Mensagem } from '@/lib/types'
import { X, Send, Loader2, Bot } from 'lucide-react'
import { MidiaMensagem } from '@/components/MidiaMensagem'

// Rótulo do separador de data (Hoje / Ontem / DD/MM/AAAA)
function labelData(iso: string): string {
  const d = new Date(iso)
  const hoje = new Date()
  const ontem = new Date()
  ontem.setDate(hoje.getDate() - 1)
  if (d.toDateString() === hoje.toDateString()) return 'Hoje'
  if (d.toDateString() === ontem.toDateString()) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function ChatPopup({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const supabase = createClient()
  const [mensagens, setMensagens] = useState<Mensagem[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [iaAtiva, setIaAtiva] = useState(lead.ia_ativa)
  const msgsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let ativo = true
    supabase
      .from('mensagens')
      .select('*')
      .eq('lead_id', lead.id)
      .order('criado_em')
      .then(({ data }) => {
        if (ativo && data) setMensagens(data as unknown as Mensagem[])
      })

    const ch = supabase
      .channel(`popup-msg-${lead.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'mensagens', filter: `lead_id=eq.${lead.id}` },
        (payload) => setMensagens((prev) => [...prev, payload.new as Mensagem]),
      )
      .subscribe()

    return () => {
      ativo = false
      supabase.removeChannel(ch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id])

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: 'smooth' })
  }, [mensagens])

  async function toggleIA(on: boolean) {
    setIaAtiva(on)
    await supabase.from('leads').update({ ia_ativa: on }).eq('id', lead.id)
  }

  async function enviar() {
    if (!draft.trim() || sending) return
    setSending(true)
    const texto = draft
    setDraft('')
    const res = await fetch('/api/mensagens/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: lead.id, texto }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      alert('Erro ao enviar: ' + (err.error || res.statusText))
    }
    setSending(false)
  }

  return (
    <div className="fixed bottom-0 right-4 z-50 flex h-[520px] max-h-[80vh] w-[360px] max-w-[calc(100vw-2rem)] flex-col rounded-t-2xl border border-slate-200 bg-white shadow-2xl">
      <div className="flex items-center gap-2 rounded-t-2xl border-b border-slate-200 bg-slate-50 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{lead.familia?.nome_responsavel || 'Sem nome'}</div>
          <div className="truncate text-[11px] text-slate-500">{lead.familia?.telefone}</div>
        </div>
        <label className="flex items-center gap-1 text-[11px] text-slate-600" title="Sara IA (ligada/desligada)">
          <Bot className="h-3.5 w-3.5" />
          <input
            type="checkbox"
            checked={iaAtiva}
            onChange={(e) => toggleIA(e.target.checked)}
            className="relative h-4 w-8 cursor-pointer appearance-none rounded-full bg-slate-300 transition before:absolute before:left-0.5 before:top-0.5 before:h-3 before:w-3 before:rounded-full before:bg-white before:transition before:content-[''] checked:bg-green-500 checked:before:translate-x-4"
          />
        </label>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Fechar">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={msgsRef} className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-3">
        {mensagens.map((m, i) => {
          const isIn = m.direcao === 'in'
          const isIA = m.direcao === 'out_ia'
          const prev = mensagens[i - 1]
          const mudouDia = !prev || new Date(prev.criado_em).toDateString() !== new Date(m.criado_em).toDateString()
          return (
            <div key={m.id}>
              {mudouDia && (
                <div className="my-2 flex justify-center">
                  <span className="rounded-full bg-slate-200/70 px-3 py-1 text-[10px] font-medium text-slate-500">
                    {labelData(m.criado_em)}
                  </span>
                </div>
              )}
              <div className={`flex ${isIn ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                    isIn
                      ? 'rounded-bl-md border border-slate-200 bg-white'
                      : isIA
                        ? 'rounded-br-md bg-green-100 text-green-900'
                        : 'rounded-br-md bg-blue-100 text-blue-900'
                  }`}
                >
                  {m.tipo_midia && m.tipo_midia !== 'texto' && m.url_midia && (
                    <div className="mb-1"><MidiaMensagem tipo={m.tipo_midia} path={m.url_midia} /></div>
                  )}
                  {m.conteudo}
                  <div className={`mt-1 text-[10px] ${isIn ? 'text-slate-400' : isIA ? 'text-green-700/70' : 'text-blue-700/70'}`}>
                    {isIA ? 'Sara IA' : isIn ? 'Família' : 'Equipe'} ·{' '}
                    {new Date(m.criado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}{' '}
                    {new Date(m.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        {mensagens.length === 0 && <div className="py-8 text-center text-xs text-slate-400">Sem mensagens ainda</div>}
      </div>

      <div className="flex gap-2 border-t border-slate-200 p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') enviar() }}
          placeholder="Mensagem..."
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
        />
        <button
          onClick={enviar}
          disabled={sending || !draft.trim()}
          className="flex items-center rounded-lg bg-blue-600 px-3 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}
