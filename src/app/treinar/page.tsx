'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Bot, Send, Loader2, GraduationCap, Check, X, BookOpen, Sparkles } from 'lucide-react'

type PlanoItem =
  | { tipo: 'conhecimento'; categoria: string; pergunta: string; resposta: string }
  | { tipo: 'regra'; texto_regra: string }

type TreinoMsg = {
  id: string
  papel: 'diretor' | 'sara'
  conteudo: string
  proposta: PlanoItem[] | null
  status: 'proposto' | 'confirmado' | 'descartado' | null
  criado_em: string
}

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

export default function TreinarSaraPage() {
  const supabase = createClient()
  const [msgs, setMsgs] = useState<TreinoMsg[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [aplicandoId, setAplicandoId] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const msgsRef = useRef<HTMLDivElement>(null)

  async function load() {
    const { data } = await supabase
      .from('sara_treinamento_mensagens')
      .select('id, papel, conteudo, proposta, status, criado_em')
      .order('criado_em', { ascending: true })
    if (data) setMsgs(data as unknown as TreinoMsg[])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight })
  }, [msgs])

  async function enviar() {
    const mensagem = draft.trim()
    if (!mensagem || enviando) return
    setEnviando(true)
    setErro(null)
    setDraft('')
    // Otimista: mostra a fala do diretor na hora.
    const tempId = `temp-${Date.now()}`
    setMsgs((prev) => [
      ...prev,
      { id: tempId, papel: 'diretor', conteudo: mensagem, proposta: null, status: null, criado_em: new Date().toISOString() },
    ])
    try {
      const res = await fetch('/api/sara/treinar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'conversar', mensagem }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || 'Falha ao falar com a Sara')
      setMsgs((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        json.diretor as TreinoMsg,
        json.sara as TreinoMsg,
      ])
    } catch (e) {
      setMsgs((prev) => prev.filter((m) => m.id !== tempId))
      setDraft(mensagem)
      setErro(e instanceof Error ? e.message : 'Erro desconhecido')
    } finally {
      setEnviando(false)
    }
  }

  async function decidir(mensagemId: string, action: 'confirmar' | 'descartar') {
    setAplicandoId(mensagemId)
    setErro(null)
    try {
      const res = await fetch('/api/sara/treinar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, mensagem_id: mensagemId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || 'Falha ao aplicar')
      const novoStatus = action === 'confirmar' ? 'confirmado' : 'descartado'
      setMsgs((prev) => prev.map((m) => (m.id === mensagemId ? { ...m, status: novoStatus } : m)))
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro desconhecido')
    } finally {
      setAplicandoId(null)
    }
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="flex-1 flex flex-col min-h-0 pl-16">
        <header className="border-b border-slate-200 bg-white px-5 py-3">
          <div className="max-w-3xl mx-auto flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-[#1A237E] text-white flex items-center justify-center flex-shrink-0">
              <GraduationCap className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Treinar a Sara</h1>
              <p className="text-xs text-slate-500 leading-tight">
                Converse com a Sara para orientá-la. Ela propõe o que aprendeu e você confirma.
              </p>
            </div>
          </div>
        </header>

        <div ref={msgsRef} className="flex-1 overflow-y-auto p-4">
          <div className="max-w-3xl mx-auto space-y-2">
            {loading ? (
              <div className="flex items-center gap-2 text-slate-500 py-8 justify-center">
                <Loader2 className="w-5 h-5 animate-spin" /> Carregando…
              </div>
            ) : msgs.length === 0 ? (
              <div className="text-center text-sm text-slate-400 py-12">
                <Bot className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                Diga algo à Sara — uma informação nova ou como ela deve atender.
                <br />
                <span className="text-xs">Ex.: “A mensalidade do maternal agora é R$ 1.200” ou “Seja mais calorosa no primeiro contato”.</span>
              </div>
            ) : (
              msgs.map((m, i) => {
                const isDiretor = m.papel === 'diretor'
                const prev = msgs[i - 1]
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
                    <div className={`flex ${isDiretor ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
                          isDiretor
                            ? 'bg-blue-600 text-white rounded-br-md'
                            : 'bg-white border border-slate-200 rounded-bl-md'
                        }`}
                      >
                        {m.conteudo}
                        <div className={`text-[10px] mt-1 ${isDiretor ? 'text-blue-100/80' : 'text-slate-400'}`}>
                          {isDiretor ? 'Você' : 'Sara'} ·{' '}
                          {new Date(m.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>

                    {/* Cartão de proposta (só nas mensagens da Sara com plano) */}
                    {!isDiretor && m.proposta && m.proposta.length > 0 && (
                      <div className="mt-1.5 flex justify-start">
                        <div className="max-w-[75%] w-full rounded-xl border border-slate-200 bg-white p-3">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 mb-2">
                            <Sparkles className="w-3.5 h-3.5 text-amber-500" /> A Sara vai aprender:
                          </div>
                          <div className="space-y-2">
                            {m.proposta.map((p, idx) => (
                              <div key={idx} className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
                                {p.tipo === 'conhecimento' ? (
                                  <>
                                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                                      <BookOpen className="w-3 h-3" /> Base de conhecimento
                                      <span className="px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600 normal-case tracking-normal">
                                        {p.categoria}
                                      </span>
                                    </div>
                                    <p className="text-sm font-medium text-slate-800">{p.pergunta}</p>
                                    <p className="text-sm text-slate-600">{p.resposta}</p>
                                  </>
                                ) : (
                                  <>
                                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                                      <Sparkles className="w-3 h-3" /> Regra de comportamento
                                    </div>
                                    <p className="text-sm text-slate-700">{p.texto_regra}</p>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>

                          {m.status === 'proposto' ? (
                            <div className="mt-3 flex gap-2">
                              <button
                                onClick={() => decidir(m.id, 'confirmar')}
                                disabled={aplicandoId === m.id}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
                              >
                                {aplicandoId === m.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                Confirmar
                              </button>
                              <button
                                onClick={() => decidir(m.id, 'descartar')}
                                disabled={aplicandoId === m.id}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                              >
                                <X className="w-4 h-4" /> Descartar
                              </button>
                            </div>
                          ) : m.status === 'confirmado' ? (
                            <div className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-green-700">
                              <Check className="w-4 h-4" /> Aplicado — a Sara já usa isso.
                            </div>
                          ) : (
                            <div className="mt-3 inline-flex items-center gap-1.5 text-sm text-slate-400">
                              <X className="w-4 h-4" /> Descartado.
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="border-t border-slate-200 bg-white px-4 py-3">
          <div className="max-w-3xl mx-auto">
            {erro && <div className="mb-2 text-xs text-red-600">{erro}</div>}
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } }}
                placeholder="Diga algo à Sara…"
                disabled={enviando}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500 disabled:opacity-60"
              />
              <button
                onClick={enviar}
                disabled={enviando || !draft.trim()}
                className="px-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 text-sm font-medium"
              >
                {enviando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
