'use client'

import { Suspense } from 'react'



import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import type { Lead, Mensagem } from '@/lib/types'
import { Bot, Send, Loader2, User, RefreshCw, ChevronLeft, BellOff, Bell, Sparkles, X, Paperclip, FileText, Music, Film } from 'lucide-react'
import { MidiaMensagem } from '@/components/MidiaMensagem'
import { MensagemStatus } from '@/components/MensagemStatus'

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

// Junta mensagens deduplicando por id e removendo os "temp-" já confirmados
// (quando chega a versão real, com mesmo conteúdo/direção, o otimista some).
function mergeMsgs(prev: Mensagem[], incoming: Mensagem[]): Mensagem[] {
  const map = new Map<string, Mensagem>()
  for (const m of [...prev, ...incoming]) map.set(m.id, m)
  const arr = Array.from(map.values())
  const reais = arr.filter((m) => !String(m.id).startsWith('temp-'))
  return arr
    .filter((m) => !String(m.id).startsWith('temp-') || !reais.some((r) => r.direcao === m.direcao && r.conteudo === m.conteudo))
    .sort((a, b) => (a.criado_em < b.criado_em ? -1 : 1))
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
  const [encerrando, setEncerrando] = useState(false)
  const [mostrarConversa, setMostrarConversa] = useState(false) // mobile: alterna lista/conversa
  const [instrucao, setInstrucao] = useState('')
  const [showInstruir, setShowInstruir] = useState(false)
  const [gerando, setGerando] = useState(false)
  const [arquivo, setArquivo] = useState<File | null>(null)
  const [legenda, setLegenda] = useState('')
  const [enviandoMidia, setEnviandoMidia] = useState(false)
  const msgsRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
    if (data) setMensagens((prev) => mergeMsgs(prev, data as Mensagem[]))
  }

  // Marca as recebidas como lidas (apaga o badge "nova" no funil).
  async function marcarLidas(leadId: string) {
    await supabase
      .from('mensagens')
      .update({ lida: true })
      .eq('lead_id', leadId)
      .eq('direcao', 'in')
      .eq('lida', false)
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
    setMensagens([]) // limpa a conversa anterior antes de carregar a nova (evita misturar leads)
    loadMensagens(activeLead.id)
    marcarLidas(activeLead.id)
    // Auto-sync ao abrir a conversa (silencioso)
    atualizarConversa(activeLead, true)

    const ch = supabase
      .channel(`msg-${activeLead.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'crm', table: 'mensagens', filter: `lead_id=eq.${activeLead.id}` }, (payload) => {
        const nova = payload.new as Mensagem
        setMensagens((prev) => mergeMsgs(prev, [nova]))
        // Chegou com a conversa aberta: já marca como lida.
        if (nova.direcao === 'in') marcarLidas(activeLead.id)
      })
      // Transição de status (enviado → entregue → lido → falhou) é um UPDATE.
      .on('postgres_changes', { event: 'UPDATE', schema: 'crm', table: 'mensagens', filter: `lead_id=eq.${activeLead.id}` }, (payload) => {
        setMensagens((prev) => mergeMsgs(prev, [payload.new as Mensagem]))
      })
      .subscribe()

    // Fallback: se o Realtime falhar, recarrega periodicamente (autoritativo)
    const poll = setInterval(() => { loadMensagens(activeLead.id) }, 5000)

    return () => { supabase.removeChannel(ch); clearInterval(poll) }
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

  // Encerrar: tira o lead do follow-up automático (não pausa a Sara — ela ainda
  // responde se a família voltar). Reabrir: devolve ao follow-up.
  async function encerrarAtendimento(acao: 'encerrar' | 'reabrir') {
    if (!activeLead || encerrando) return
    setEncerrando(true)
    try {
      const r = await fetch('/api/atendimento/encerrar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: activeLead.id, acao }),
      })
      const j = await r.json()
      if (j?.ok) {
        const patch: Partial<Lead> = {
          followup_encerrado_em: acao === 'encerrar' ? new Date().toISOString() : null,
          sugestao_encerramento: false,
        }
        setActiveLead({ ...activeLead, ...patch })
        setLeads((prev) => prev.map((l) => (l.id === activeLead.id ? { ...l, ...patch } : l)))
      } else {
        alert('Erro: ' + (j?.error || `falha ao ${acao}`))
      }
    } catch {
      alert(`Falha ao ${acao} o atendimento.`)
    } finally {
      setEncerrando(false)
    }
  }

  // Pede à Sara que redija a próxima mensagem seguindo a INSTRUÇÃO do atendente
  // (ou só pelo contexto, se vazia). Não envia: cai no rascunho para revisão.
  async function pedirSara() {
    if (!activeLead || gerando) return
    setGerando(true)
    try {
      const res = await fetch('/api/sara/sugerir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: activeLead.id, instrucao: instrucao.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.resposta) {
        alert('A Sara não gerou o rascunho: ' + (data.error || res.statusText))
      } else {
        setDraft(data.resposta)
        setShowInstruir(false)
      }
    } catch (e) {
      alert('Falha ao chamar a Sara: ' + (e instanceof Error ? e.message : 'erro'))
    } finally {
      setGerando(false)
    }
  }

  async function enviar() {
    if (!draft.trim() || !activeLead || sending) return
    setSending(true)
    const texto = draft
    setDraft('')

    // Optimistic: aparece na hora, sem depender do Realtime
    const tempId = `temp-${Date.now()}`
    const otimista: Mensagem = {
      id: tempId, lead_id: activeLead.id, direcao: 'out_humano', conteudo: texto,
      tipo_midia: 'texto', url_midia: null, enviado_por: null, whatsapp_message_id: null,
      criado_em: new Date().toISOString(),
      status: 'enviado', erro_envio: null, lida: false, agente: null, agente_origem: null,
    }
    setMensagens((prev) => mergeMsgs(prev, [otimista]))

    const res = await fetch('/api/mensagens/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: activeLead.id, texto }),
    })
    const j = await res.json().catch(() => ({}))

    if (!res.ok) {
      alert('Erro ao enviar: ' + (j.error || res.statusText))
      // Rollback do otimista e devolve o texto ao campo
      setMensagens((prev) => prev.filter((m) => m.id !== tempId))
      setDraft(texto)
    } else if (j?.janela_fechada) {
      // Fora da janela de 24h: NÃO foi enviado. Já há alerta em "Alertas" para
      // envio manual pelo celular. Remove o otimista e devolve o texto.
      setMensagens((prev) => prev.filter((m) => m.id !== tempId))
      setDraft(texto)
      alert(j.aviso || 'Fora da janela de 24h. Envie manualmente pelo celular (veja em Alertas).')
    }
    setSending(false)
  }

  function escolherArquivo(f: File | null) {
    if (!f) return
    const MAX = 4 * 1024 * 1024
    if (f.size > MAX) {
      alert('Arquivo muito grande (máx. 4 MB).')
      return
    }
    setArquivo(f)
  }

  function cancelarArquivo() {
    setArquivo(null)
    setLegenda('')
    if (fileRef.current) fileRef.current.value = ''
  }

  // Envia o arquivo anexado (documento/imagem) pelo WhatsApp e grava no histórico.
  async function enviarMidia() {
    if (!arquivo || !activeLead || enviandoMidia) return
    setEnviandoMidia(true)
    const cap = legenda.trim()

    // Otimista: um balão de texto some quando a mensagem real (com a mídia) chega.
    const tempId = `temp-${Date.now()}`
    const otimista: Mensagem = {
      id: tempId, lead_id: activeLead.id, direcao: 'out_humano', conteudo: cap || arquivo.name,
      tipo_midia: 'texto', url_midia: null, enviado_por: null, whatsapp_message_id: null,
      criado_em: new Date().toISOString(),
      status: 'enviado', erro_envio: null, lida: false, agente: null, agente_origem: null,
    }
    setMensagens((prev) => mergeMsgs(prev, [otimista]))

    try {
      const fd = new FormData()
      fd.append('lead_id', activeLead.id)
      fd.append('caption', cap)
      fd.append('file', arquivo)
      const res = await fetch('/api/mensagens/enviar-midia', { method: 'POST', body: fd })
      const j = await res.json().catch(() => ({}))

      if (!res.ok) {
        setMensagens((prev) => prev.filter((m) => m.id !== tempId))
        alert('Erro ao enviar arquivo: ' + (j.error || res.statusText))
      } else if (j?.janela_fechada) {
        setMensagens((prev) => prev.filter((m) => m.id !== tempId))
        alert(j.aviso || 'Fora da janela de 24h. Envie manualmente pelo celular.')
      } else {
        cancelarArquivo()
        if (j.mensagem) setMensagens((prev) => mergeMsgs(prev, [j.mensagem as Mensagem]))
        else loadMensagens(activeLead.id)
      }
    } catch (e) {
      setMensagens((prev) => prev.filter((m) => m.id !== tempId))
      alert('Falha ao enviar arquivo: ' + (e instanceof Error ? e.message : 'erro'))
    } finally {
      setEnviandoMidia(false)
    }
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

                {activeLead.followup_encerrado_em ? (
                  <button
                    onClick={() => encerrarAtendimento('reabrir')}
                    disabled={encerrando}
                    title="Reabrir: o lead volta a receber follow-up automático."
                    className="flex items-center gap-1.5 text-xs text-emerald-700 hover:text-emerald-800 border border-emerald-200 bg-emerald-50 rounded-lg px-2.5 py-1.5 disabled:opacity-50"
                  >
                    {encerrando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
                    <span className="hidden sm:inline">Reabrir atendimento</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (confirm('Encerrar o atendimento?\n\nO lead sai do follow-up automático (a Sara não manda mais mensagens sozinha). Se a família voltar a escrever, a Sara ainda responde normalmente.')) {
                        encerrarAtendimento('encerrar')
                      }
                    }}
                    disabled={encerrando}
                    title="Encerrar: tira o lead do follow-up automático. A Sara continua respondendo se a família voltar."
                    className="flex items-center gap-1.5 text-xs text-red-600 hover:text-red-700 border border-red-200 rounded-lg px-2.5 py-1.5 disabled:opacity-50"
                  >
                    {encerrando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BellOff className="w-3.5 h-3.5" />}
                    <span className="hidden sm:inline">Encerrar atendimento</span>
                  </button>
                )}
              </div>

              {activeLead.sugestao_encerramento && !activeLead.followup_encerrado_em && (
                <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 flex items-center gap-2">
                  <Bot className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="min-w-0">
                    A Sara sugere encerrar este atendimento
                    {activeLead.sugestao_encerramento_motivo ? `: ${activeLead.sugestao_encerramento_motivo}` : '.'}
                  </span>
                  <button
                    onClick={() => encerrarAtendimento('encerrar')}
                    disabled={encerrando}
                    className="ml-auto flex-shrink-0 rounded-md bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    Encerrar
                  </button>
                </div>
              )}

              {activeLead.followup_encerrado_em && (
                <div className="px-4 py-2 bg-slate-100 border-b border-slate-200 text-xs text-slate-600 flex items-center gap-2">
                  <BellOff className="w-3.5 h-3.5 flex-shrink-0" />
                  Atendimento encerrado — fora do follow-up automático. A Sara ainda responde se a família escrever.
                </div>
              )}

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
                          <div className={`text-[10px] mt-1 flex items-center gap-1 ${isIn ? 'text-slate-400' : isIA ? 'text-green-700/70' : 'text-blue-700/70'}`}>
                            <span>{isIA ? 'Sara IA' : isIn ? 'Família' : 'Equipe'} · {new Date(m.criado_em).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} {new Date(m.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                            {!isIn && <MensagemStatus status={m.status} erro_envio={m.erro_envio} />}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {mensagens.length === 0 && <div className="text-center text-xs text-slate-400 py-8">Sem mensagens ainda</div>}
              </div>

              <div className="border-t border-slate-200 px-3 pt-2">
                {!showInstruir ? (
                  <button
                    onClick={() => setShowInstruir(true)}
                    className="mb-1 flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-green-700"
                  >
                    <Sparkles className="w-3 h-3" /> Pedir à Sara para redigir
                  </button>
                ) : (
                  <div className="mb-2 rounded-lg border border-green-200 bg-green-50/70 p-2">
                    <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-green-800">
                      <Sparkles className="w-3 h-3" /> Instrução para a Sara
                      <button
                        onClick={() => setShowInstruir(false)}
                        className="ml-auto text-green-700/60 hover:text-green-900"
                        aria-label="Fechar instrução"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    <textarea
                      value={instrucao}
                      onChange={(e) => setInstrucao(e.target.value)}
                      placeholder="Ex.: ofereça terça 15h · responda a objeção de preço ancorando no valor base. (vazio = continuar pelo contexto)"
                      rows={2}
                      className="w-full resize-none rounded border border-green-200 px-2 py-1 text-[12px] outline-none focus:border-green-500"
                    />
                    <button
                      onClick={pedirSara}
                      disabled={gerando}
                      className="mt-1 flex w-full items-center justify-center gap-1 rounded bg-green-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-green-700 disabled:opacity-50"
                    >
                      {gerando ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      {gerando ? 'Gerando…' : 'Gerar rascunho'}
                    </button>
                  </div>
                )}
              </div>

              {arquivo && (
                <div className="mx-3 mb-2 rounded-lg border border-blue-200 bg-blue-50/70 p-2">
                  <div className="flex items-center gap-2">
                    {arquivo.type.startsWith('image/') ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={URL.createObjectURL(arquivo)} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
                    ) : arquivo.type.startsWith('audio/') ? (
                      <Music className="w-8 h-8 text-blue-600 flex-shrink-0" />
                    ) : arquivo.type.startsWith('video/') ? (
                      <Film className="w-8 h-8 text-blue-600 flex-shrink-0" />
                    ) : (
                      <FileText className="w-8 h-8 text-blue-600 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-slate-700 truncate">{arquivo.name}</div>
                      <div className="text-[10px] text-slate-500">{(arquivo.size / 1024).toFixed(0)} KB</div>
                    </div>
                    <button
                      onClick={cancelarArquivo}
                      className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                      aria-label="Remover arquivo"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <input
                      value={legenda}
                      onChange={(e) => setLegenda(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') enviarMidia() }}
                      placeholder="Legenda (opcional)"
                      className="flex-1 px-2 py-1.5 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={enviarMidia}
                      disabled={enviandoMidia}
                      className="px-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 text-sm font-medium"
                    >
                      {enviandoMidia ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      <span className="hidden sm:inline">{enviandoMidia ? 'Enviando…' : 'Enviar arquivo'}</span>
                    </button>
                  </div>
                </div>
              )}

              <div className="px-3 pb-3 flex gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,audio/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
                  className="hidden"
                  onChange={(e) => escolherArquivo(e.target.files?.[0] || null)}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  title="Anexar arquivo (documento, imagem, áudio ou vídeo)"
                  className="px-3 border border-slate-300 text-slate-500 hover:text-blue-600 hover:border-blue-400 rounded-lg flex items-center"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
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
