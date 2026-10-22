/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { Loader2, BellRing, RefreshCw, MessageSquare, Check, Clock, Send, CalendarX, Copy, ExternalLink } from 'lucide-react'

type Pendente = {
  id: string
  motivo_transbordo: string | null
  transbordo_em: string | null
  familia: { nome_responsavel: string | null; telefone: string | null } | null
  coluna: { nome: string | null } | null
}

type Engaj = {
  id: string
  mensagem: string | null
  criado_em: string | null
  lead_id: string | null
  familia: { nome_responsavel: string | null; telefone: string | null } | null
}

const ehPerdido = (nome: string | null | undefined) => /perdid/i.test(nome || '')

// O corpo do alerta guarda "O X precisa receber esta mensagem ...:\n\n<mensagem>". Extrai só a mensagem.
function soMensagem(texto: string | null): string {
  if (!texto) return ''
  const i = texto.indexOf('\n\n')
  return i >= 0 ? texto.slice(i + 2).trim() : texto.trim()
}

// Link wa.me que abre a conversa da família no WhatsApp Web/app com a mensagem
// já pré-digitada — um clique e é só enviar. Normaliza o número para 55 + dígitos.
function waLink(tel: string | null | undefined, msg: string): string {
  const d = (tel || '').replace(/\D/g, '')
  if (!d) return '#'
  const full = d.startsWith('55') ? d : `55${d}`
  return `https://wa.me/${full}?text=${encodeURIComponent(msg)}`
}

function tempoRelativo(iso: string | null) {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return `há ${d} dia${d > 1 ? 's' : ''}`
}

export default function PendentesPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [lista, setLista] = useState<Pendente[]>([])
  const [reeng, setReeng] = useState<any[]>([])
  const [risco, setRisco] = useState<any[]>([])
  const [resolvendo, setResolvendo] = useState<string | null>(null)
  const [enviando, setEnviando] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [engaj, setEngaj] = useState<Engaj[]>([])
  const [copiado, setCopiado] = useState<string | null>(null)

  async function carregar() {
    const [tb, rg, rc, eng] = await Promise.all([
      supabase
        .from('leads')
        .select('id, motivo_transbordo, transbordo_em, familia:familias(nome_responsavel, telefone), coluna:colunas(nome)')
        .eq('precisa_atendimento_humano', true)
        .eq('arquivado', false)
        .order('transbordo_em', { ascending: false, nullsFirst: false }),
      supabase.rpc('leads_reengajaveis'),
      supabase
        .from('leads')
        .select('id, no_show_em, risco_no_show, data_proxima_acao, familia:familias(nome_responsavel, telefone), coluna:colunas(nome)')
        .or('risco_no_show.eq.true,no_show_em.not.is.null')
        .eq('arquivado', false),
      fetch('/api/alertas/engajamento').then((r) => r.json()).catch(() => ({ items: [] })),
    ])
    // Só leads ATIVOS: fora os que estão na coluna "Perdidos".
    const listaAtiva = ((tb.data as unknown as Pendente[]) || []).filter((p) => !ehPerdido(p.coluna?.nome))
    const reengAtivo = ((rg.data as any[]) || []).filter((r) => !ehPerdido(r.etapa))
    const riscoAtivo = ((rc.data as any[]) || []).filter((r) => !ehPerdido(r.coluna?.nome))
    setLista(listaAtiva)
    setReeng(reengAtivo)
    setRisco(riscoAtivo)
    setEngaj((eng?.items as Engaj[]) || [])
    setLoading(false)
  }

  async function marcarEngEnviado(id: string) {
    if (resolvendo) return
    setResolvendo(id)
    try {
      await fetch('/api/alertas/engajamento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setEngaj((prev) => prev.filter((e) => e.id !== id))
    } finally {
      setResolvendo(null)
    }
  }

  async function copiar(id: string, texto: string) {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(id)
      setTimeout(() => setCopiado((c) => (c === id ? null : c)), 1500)
    } catch { /* clipboard indisponível */ }
  }
  useEffect(() => { carregar() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  async function resolver(id: string) {
    if (resolvendo) return
    setResolvendo(id)
    try {
      await supabase
        .from('leads')
        .update({ precisa_atendimento_humano: false, transbordo_em: null })
        .eq('id', id)
      setLista((prev) => prev.filter((p) => p.id !== id))
    } finally {
      setResolvendo(null)
    }
  }

  async function resolverRisco(id: string) {
    if (resolvendo) return
    setResolvendo(id)
    try {
      await supabase.from('leads').update({ risco_no_show: false }).eq('id', id)
      setRisco((prev) => prev.filter((r) => r.id !== id))
    } finally {
      setResolvendo(null)
    }
  }

  async function enviarRetomada(id: string) {
    setEnviando(id)
    setAviso(null)
    try {
      const r = await fetch('/api/reengajar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: id }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'falha')
      setReeng((prev) => prev.filter((x) => x.id !== id))
      setAviso('Template retomada_lead enviado. 👍')
    } catch (e) {
      setAviso(`Erro ao enviar: ${e instanceof Error ? e.message : 'desconhecido'}`)
    } finally {
      setEnviando(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="mx-auto w-full max-w-3xl p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <BellRing className="h-5 w-5 text-amber-600" /> Atendimentos pendentes
              {lista.length > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-bold text-amber-700">{lista.length}</span>
              )}
            </h1>
            <p className="text-sm text-slate-500">Conversas em que a Sara pausou e aguardam você. Confiável — não depende do WhatsApp.</p>
          </div>
          <button onClick={() => { setLoading(true); carregar() }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando...</div>
        ) : lista.length === 0 && reeng.length === 0 && risco.length === 0 && engaj.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            <Check className="mx-auto mb-2 h-6 w-6 text-green-500" />
            Nenhum atendimento pendente. Tudo em dia. 🎉
          </div>
        ) : (
          <div className="space-y-2">
            {lista.map((p) => (
              <div key={p.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{p.familia?.nome_responsavel || 'Família'}</span>
                      {p.coluna?.nome && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{p.coluna.nome}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">{p.familia?.telefone || ''}</div>
                    <p className="mt-1.5 text-sm text-slate-600">{p.motivo_transbordo || 'Atendimento humano solicitado.'}</p>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Clock className="h-3 w-3" /> {tempoRelativo(p.transbordo_em)}</div>
                  </div>
                  <div className="flex flex-shrink-0 flex-col gap-1.5">
                    <Link href={`/chat?lead=${p.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700">
                      <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
                    </Link>
                    <button onClick={() => resolver(p.id)} disabled={resolvendo === p.id} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                      {resolvendo === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Resolver
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Enviar manualmente — resposta gerada fora da janela de 24h (envio humano pelo celular). */}
        {engaj.length > 0 && (
          <div className="mt-6">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Send className="h-4 w-4 text-indigo-600" /> Enviar manualmente — janela fechada
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-bold text-indigo-700">{engaj.length}</span>
            </h2>
            <p className="mb-2 text-xs text-slate-400">
              Respostas prontas que não puderam sair pela API (mais de 24h sem mensagem da família). Clique em <strong>Abrir no WhatsApp</strong> — a conversa abre com a mensagem já digitada, é só enviar. O envio humano não depende da janela.
            </p>
            <div className="space-y-2">
              {engaj.map((e) => {
                const msg = soMensagem(e.mensagem)
                return (
                  <div key={e.id} className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-slate-800">{e.familia?.nome_responsavel || 'Família'}</span>
                          {e.familia?.telefone && <span className="text-xs text-slate-400">{e.familia.telefone}</span>}
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-700">{msg}</p>
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Clock className="h-3 w-3" /> {tempoRelativo(e.criado_em)}</div>
                      </div>
                      <div className="flex flex-shrink-0 flex-col gap-1.5">
                        {e.familia?.telefone && (
                          <a href={waLink(e.familia.telefone, msg)} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700">
                            <ExternalLink className="h-3.5 w-3.5" /> Abrir no WhatsApp
                          </a>
                        )}
                        <button onClick={() => copiar(e.id, msg)}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
                          <Copy className="h-3.5 w-3.5" /> {copiado === e.id ? 'Copiado!' : 'Copiar'}
                        </button>
                        {e.lead_id && (
                          <Link href={`/chat?lead=${e.lead_id}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
                            <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
                          </Link>
                        )}
                        <button onClick={() => marcarEngEnviado(e.id)} disabled={resolvendo === e.id}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                          {resolvendo === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Marcar enviado
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Reengajar — leads de captação com a janela de 24h fechada (retomada_lead manual). */}
        {reeng.length > 0 && (
          <div className="mt-6">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Clock className="h-4 w-4 text-amber-600" /> Reengajar — janela fechada
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">{reeng.length}</span>
            </h2>
            <p className="mb-2 text-xs text-slate-400">
              Leads calados há mais de 24h que o follow-up automático não alcança (Sara pausada ou follow-up esgotado). Fora da janela, só o template reabre a conversa — envie o <strong>retomada_lead</strong>.
            </p>
            {aviso && <div className="mb-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">{aviso}</div>}
            <div className="space-y-2">
              {reeng.map((r) => {
                const dias = Math.floor((r.horas_silencio || 0) / 24)
                const silencio = dias >= 1 ? `${dias} dia${dias > 1 ? 's' : ''}` : `${r.horas_silencio}h`
                return (
                  <div key={r.id} className="rounded-xl border border-amber-200 bg-amber-50/40 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-slate-800">{r.familia || 'Família'}</span>
                          {r.etapa && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{r.etapa}</span>}
                          {r.ia_ativa === false && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] text-slate-600">Sara pausada</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">{r.telefone || ''}</div>
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><Clock className="h-3 w-3" /> calada há {silencio}</div>
                      </div>
                      <div className="flex flex-shrink-0 flex-col gap-1.5">
                        <button onClick={() => enviarRetomada(r.id)} disabled={enviando === r.id}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60">
                          {enviando === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Enviar retomada
                        </button>
                        <Link href={`/chat?lead=${r.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50">
                          <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
                        </Link>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Risco de no-show / faltou à visita */}
        {risco.length > 0 && (
          <div className="mt-6">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <CalendarX className="h-4 w-4 text-red-600" /> Risco de no-show / faltou
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">{risco.length}</span>
            </h2>
            <p className="mb-2 text-xs text-slate-400">
              Leads com visita hoje ainda sem confirmar presença, ou que faltaram e a Sara está tentando remarcar. Um toque humano aqui aumenta o comparecimento.
            </p>
            <div className="space-y-2">
              {risco.map((r) => {
                const faltou = !!r.no_show_em
                return (
                  <div key={r.id} className="rounded-xl border border-red-200 bg-red-50/40 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-slate-800">{r.familia?.nome_responsavel || 'Família'}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] ${faltou ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                            {faltou ? 'Faltou — reagendar' : 'Risco de no-show'}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">{r.familia?.telefone || ''}</div>
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-slate-400">
                          <Clock className="h-3 w-3" /> {faltou ? `faltou ${tempoRelativo(r.no_show_em)}` : 'visita hoje'}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 flex-col gap-1.5">
                        <Link href={`/chat?lead=${r.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700">
                          <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
                        </Link>
                        <button onClick={() => resolverRisco(r.id)} disabled={resolvendo === r.id} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                          {resolvendo === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Resolver
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
