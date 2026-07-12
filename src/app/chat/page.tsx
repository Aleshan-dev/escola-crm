'use client'

import { Suspense } from 'react'



import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import type { Lead, Mensagem } from '@/lib/types'
import { Bot, Send, Loader2, User, RefreshCw, ChevronLeft } from 'lucide-react'
import { MidiaMensagem } from '@/components/MidiaMensagem'

// Rótulo do separador de data (estilo WhatsApp): Hoje / Ontem / DD/MM/AAAA
function labelData(iso: string): string {
  const d = new Date(iso)
  const hoje = new Date()
  const ontem = new Date()
  ontem.setDate(hoje.getDate() - 1)
  if (d.toDateString() === hoje.toDateString()) return 'Hoje'
  if (d.toDateString() === ontem.toDateString()) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function ChatPageInner() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const [leads, setLeads] = useState<Lead[]>([])
  const [activeLead, setActiveLead] = useState<Lead | null>(null)
  const [mensagens, setMensagens] = useState<Mensagem[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [atualizando, setAtualizando] = useState(false)
  const [mostrarConversa, setMostrarConversa] = useState(false) // mobile: alterna lista/conversa
  const msgsRef = useRef<HTMLDivElement>(null)

  async function loadLeads() {
    const { data } = await supabase
      .from('leads')
      .select('*, familia:familias(*), crianca:criancas(*)')
      .order('atualizado_em', { ascending: false })
    if (data) {
      setLeads(data as Lead[])
      const want = searchParams.get('lead')
      const initial = want ? data.find((l: Lead) => l.id === want) : data[0]
      if (initial) setActiveLead(initial as Lead)
    }
  }

  async function loadMensagens(leadId: string) {
    const { data } = await supabase
      .from('mensagens')
      .select('*')
      .eq('lead_id', leadId)
      .order('criado_em')
    if (data) setMensagens(data as Mensagem[])
  }

  // Puxa do Evolution as mensagens que faltam (inclui as enviadas manualmente pelo celular)
  async function atualizarConversa(lead?: Lead, silencioso = false) {
    const alvo = lead || activeLead
    const tel = alvo?.familia?.telefone
    if (!alvo || !tel) return
    if (!silencioso) setAtualizando(true)
    try {
      await fetch(`/api/admin/sync-chat?telefone=${encodeURIComponent(tel)}`, { credentials: 'include' })
      await loadMensagens(alvo.id)
    } catch {
      // falha silenciosa: mantém o que já está na tela
    } finally {
      if (!silencioso) setAtualizando(false)
    }
  }

  useEffect(() => { loadLeads() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  useEffect(() => {
    if (!activeLead) return
    loadMensagens(activeLead.id)
    // Auto-sync ao abrir a conversa (silencioso)
    atualizarConversa(activeLead, true)

    const ch = supabase
      .channel(`msg-${activeLead.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensagens', filter: `lead_id=eq.${activeLead.id}` }, (payload) => {
        setMensagens((prev) => [...prev, payload.new as Mensagem])
      })
      .subscribe()

    return () => { supabase.removeChannel(ch) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLead])

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: 'smooth' })
  }, [mensagens])

  async function toggleIA(on: boolean) {
    if (!activeLead) return
    await supabase.from('leads').update({ ia_ativa: on }).eq('id', activeLead.id)
    setActiveLead({ ...activeLead, ia_ativa: on })
  }

  async function enviar() {
    if (!draft.trim() || !activeLead || sending) return
    setSending(true)
    const texto = draft
    setDraft('')

    const res = await fetch('/api/mensagens/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: activeLead.id, texto }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      alert('Erro ao enviar: ' + (err.error || res.statusText))
    }
    setSending(false)
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Topbar />

      <div className="flex-1 flex overflow-hidden">
        <aside className={`w-full md:w-[260px] flex-shrink-0 border-r border-slate-200 bg-white overflow-y-auto ${mostrarConversa ? 'hidden md:block' : 'block'}`}>
          {leads.length === 0 && (
            <div className="p-6 text-center text-xs text-slate-400">Nenhum lead ainda. Quando alguém mandar mensagem no WhatsApp, aparece aqui.</div>
          )}
          {leads.map((l) => {
            const active = activeLead?.id === l.id
            return (
              <button
                key={l.id}
                onClick={() => { setActiveLead(l); setMostrarConversa(true) }}
                className={`w-full text-left p-3 border-b border-slate-100 hover:bg-slate-50 transition ${active ? 'bg-blue-50' : ''}`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium truncate flex-1">{l.familia?.nome_responsavel || 'Sem nome'}</span>
                  {l.ia_ativa && <Bot className="w-3 h-3 text-green-600" />}
                </div>
                <div className="text-xs text-slate-500 truncate">{l.familia?.telefone}</div>
              </button>
            )
          })}
        </aside>

        <main className={`flex-1 flex-col bg-white ${mostrarConversa ? 'flex' : 'hidden md:flex'}`}>
          {!activeLead ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              Selecione uma conversa
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3 flex-wrap">
                <button
                  onClick={() => setMostrarConversa(false)}
                  className="md:hidden text-slate-500 hover:text-slate-700"
                  aria-label="Voltar para a lista"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center">
                  <User className="w-4 h-4 text-slate-500" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">{activeLead.familia?.nome_responsavel}</div>
                  <div className="text-xs text-slate-500">{activeLead.familia?.telefone} · Score {activeLead.score}</div>
                </div>
                <button
                  onClick={() => atualizarConversa()}
                  disabled={atualizando}
                  title="Puxar mensagens recentes do WhatsApp (inclui as enviadas pelo celular)"
                  className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-600 border border-slate-200 rounded-lg px-2.5 py-1.5 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${atualizando ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">{atualizando ? 'Atualizando...' : 'Atualizar conversa'}</span>
                </button>
                <label className="flex items-center gap-2 text-xs">
                  <Bot className="w-4 h-4 text-slate-500" />
                  <span className="text-slate-600">Sara IA</span>
                  <input
                    type="checkbox"
                    checked={activeLead.ia_ativa}
                    onChange={(e) => toggleIA(e.target.checked)}
                    className="h-4 w-8 appearance-none rounded-full bg-slate-300 checked:bg-green-500 relative cursor-pointer transition before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-3 before:h-3 before:bg-white before:rounded-full before:transition checked:before:translate-x-4"
                  />
                  <span className={`text-xs font-medium ${activeLead.ia_ativa ? 'text-green-600' : 'text-slate-400'}`}>
                    {activeLead.ia_ativa ? 'ativa' : 'inativa'}
                  </span>
                </label>
              </div>

              <div ref={msgsRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                {mensagens.map((m, i) => {
                  const isIn = m.direcao === 'in'
                  const isIA = m.direcao === 'out_ia'
                  const prev = mensagens[i - 1]
                  const mudouDia = !prev || new Date(prev.criado_em).toDateString() !== new Date(m.criado_em).toDateString()
                  return (
                    <div key={m.id}>
                      {mudouDia && (
                        <div className="flex justify-center my-3">
                          <span className="text-[10px] font-medium text-slate-500 bg-slate-200/70 rounded-full px-3 py-1">
                            {labelData(m.criado_em)}
                          </span>
                        </div>
                      )}
                      <div className={`flex ${isIn ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[70%] px-3 py-2 rounded-2xl text-sm ${isIn ? 'bg-white border border-slate-200 rounded-bl-md' : isIA ? 'bg-green-100 text-green-900 rounded-br-md' : 'bg-blue-100 text-blue-900 rounded-br-md'}`}>
                          {m.tipo_midia && m.tipo_midia !== 'texto' && m.url_midia && (
                            <div className="mb-1"><MidiaMensagem tipo={m.tipo_midia} path={m.url_midia} /></div>
                          )}
                          {m.conteudo}
                          <div className={`text-[10px] mt-1 ${isIn ? 'text-slate-400' : isIA ? 'text-green-700/70' : 'text-blue-700/70'}`}>
                            {isIA ? 'Sara IA' : isIn ? 'Família' : 'Equipe'} · {new Date(m.criado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} {new Date(m.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {mensagens.length === 0 && <div className="text-center text-xs text-slate-400 py-8">Sem mensagens ainda</div>}
              </div>

              <div className="p-3 border-t border-slate-200 flex gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') enviar() }}
                  placeholder="Mensagem..."
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                />
                <button
                  onClick={enviar}
                  disabled={sending || !draft.trim()}
                  className="px-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 text-sm font-medium"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen">Carregando...</div>}>
      <ChatPageInner />
    </Suspense>
  )
}
