'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Topbar } from '@/components/Topbar'
import { ROTULO_ESTADO, TIPOS_CASO, type EstadoCaso } from '@/lib/casos/regras'
import {
  Briefcase, Loader2, RefreshCw, MessageSquare, Check, HelpCircle, UserRound, Send, Bot, Clock,
} from 'lucide-react'

type ItemLista = {
  id: string
  numero: number
  agente: 'sara' | 'salomao'
  titulo: string
  tipo: string
  origem: string
  estado: EstadoCaso
  cobrancas: number
  criado_em: string
  fechado_em: string | null
  familia: { nome_responsavel: string | null } | null
}

type Evento = { id: string; tipo: string; ator: string; detalhe: Record<string, unknown> | null; criado_em: string }
type Chat = { id: string; papel: 'user' | 'assistant'; conteudo: string; criado_em: string }
type Detalhe = {
  caso: ItemLista & {
    lead_id: string
    resumo: string
    motivo_bloqueio: string | null
    contexto: string | null
    nota_equipe: string | null
    fechado_por: string | null
    lead: { ia_ativa: boolean; precisa_atendimento_humano: boolean; coluna: { nome: string } | null } | null
  }
  eventos: Evento[]
  chat: Chat[]
  nomes: Record<string, string>
}

const COR_ESTADO: Record<EstadoCaso, string> = {
  aguardando_equipe: 'bg-amber-100 text-amber-800',
  aguardando_familia: 'bg-sky-100 text-sky-800',
  concluido: 'bg-emerald-100 text-emerald-800',
  escalado: 'bg-violet-100 text-violet-800',
  cancelado: 'bg-slate-100 text-slate-600',
}

const ROTULO_EVENTO: Record<string, string> = {
  aberto: 'Caso aberto',
  pedido_info: 'Equipe pediu informação à família',
  familia_respondeu: 'Família respondeu',
  familia_sem_resposta: 'Família não respondeu em 48h — voltou para a equipe',
  concluido: 'Equipe concluiu',
  escalado: 'Passado para atendimento humano',
  cancelado: 'Cancelado',
  aviso_enviado: 'Aviso enviado à equipe no WhatsApp',
  cobranca: 'Cobrança: Caso parado',
  retorno_enviado: 'IA comunicou à família',
  retorno_pulado: 'IA pausada — decisão NÃO comunicada à família',
  retorno_falhou: 'Falha ao comunicar à família',
  comando_whatsapp: 'Respondido pelo WhatsApp',
}

const nomeAgente = (a: string) => (a === 'salomao' ? 'Salomão' : 'Sara')

function tempoRelativo(iso: string | null) {
  if (!iso) return '—'
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return `há ${d} dia${d > 1 ? 's' : ''}`
}

const dataHora = (iso: string) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Rio_Branco', dateStyle: 'short', timeStyle: 'short' })

function atorLegivel(ator: string, nomes: Record<string, string>) {
  if (ator.startsWith('equipe:')) return nomes[ator.slice(7)] || 'Equipe'
  if (ator === 'whatsapp') return 'Equipe (WhatsApp)'
  if (ator === 'sistema') return 'Sistema'
  return nomeAgente(ator)
}

export default function CasosPage() {
  return (
    <Suspense fallback={null}>
      <Casos />
    </Suspense>
  )
}

function Casos() {
  const router = useRouter()
  const params = useSearchParams()
  const selecionado = params.get('caso')
  const [aba, setAba] = useState<'abertos' | 'concluidos'>('abertos')
  const [lista, setLista] = useState<ItemLista[]>([])
  const [abertos, setAbertos] = useState(0)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const carregar = useCallback(async () => {
    setCarregando(true)
    setErro(null)
    const r = await fetch(`/api/casos?aba=${aba}`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) setErro(j.error || 'Erro ao carregar')
    setLista(j.casos ?? [])
    setAbertos(j.abertos ?? 0)
    setCarregando(false)
  }, [aba])

  useEffect(() => { carregar() }, [carregar])

  const selecionar = (id: string) => router.replace(`/casos?caso=${id}`, { scroll: false })

  return (
    <div className="min-h-screen bg-slate-50 pl-16">
      <Topbar />
      <div className="mx-auto max-w-7xl p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><Briefcase className="h-5 w-5" /> Casos</h1>
            <p className="text-sm text-slate-500">O que a Sara e o Salomão não conseguiram resolver sozinhos. A IA segue falando com a família enquanto vocês decidem.</p>
          </div>
          <button onClick={carregar} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex border-b border-slate-100 text-sm">
              {(['abertos', 'concluidos'] as const).map((a) => (
                <button key={a} onClick={() => setAba(a)}
                  className={`flex-1 px-3 py-2.5 font-medium ${aba === a ? 'border-b-2 border-blue-600 text-blue-700' : 'text-slate-500 hover:text-slate-700'}`}>
                  {a === 'abertos' ? `Abertos (${abertos})` : 'Concluídos'}
                </button>
              ))}
            </div>
            {carregando ? (
              <div className="flex items-center gap-2 p-4 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando...</div>
            ) : erro ? (
              <div className="p-4 text-sm text-red-600">{erro}</div>
            ) : lista.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-400">{aba === 'abertos' ? 'Nenhum Caso aberto. 🎉' : 'Nenhum Caso concluído ainda.'}</div>
            ) : (
              <ul className="max-h-[calc(100vh-220px)] divide-y divide-slate-100 overflow-y-auto">
                {lista.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => selecionar(c.id)}
                      className={`w-full px-4 py-3 text-left hover:bg-slate-50 ${selecionado === c.id ? 'bg-blue-50' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium text-slate-800">#C{c.numero} · {c.titulo}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${COR_ESTADO[c.estado]}`}>{ROTULO_ESTADO[c.estado]}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                        <span>{c.familia?.nome_responsavel || 'Família'}</span>
                        <span>·</span>
                        <span>{TIPOS_CASO[c.tipo as keyof typeof TIPOS_CASO] ?? c.tipo}</span>
                        <span>·</span>
                        <span>{nomeAgente(c.agente)}</span>
                        <span>·</span>
                        <span>{aba === 'abertos' ? tempoRelativo(c.criado_em) : tempoRelativo(c.fechado_em)}</span>
                        {c.cobrancas > 0 && <span className="text-amber-700">· {c.cobrancas} cobrança{c.cobrancas > 1 ? 's' : ''}</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            {selecionado
              ? <DetalheCaso key={selecionado} id={selecionado} aoMudar={carregar} />
              : <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-400">Selecione um Caso na lista.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function DetalheCaso({ id, aoMudar }: { id: string; aoMudar: () => void }) {
  const [d, setD] = useState<Detalhe | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [aba, setAba] = useState<'decidir' | 'ia'>('decidir')

  const carregar = useCallback(async () => {
    const r = await fetch(`/api/casos/${id}`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setErro(j.error || 'Erro ao carregar'); return }
    setD(j)
  }, [id])

  useEffect(() => { carregar() }, [carregar])

  if (erro) return <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-red-600">{erro}</div>
  if (!d) return <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando...</div>

  const c = d.caso
  const iaPausada = c.lead && (!c.lead.ia_ativa || c.lead.precisa_atendimento_humano)

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-slate-500">#C{c.numero} · {nomeAgente(c.agente)} · {TIPOS_CASO[c.tipo as keyof typeof TIPOS_CASO] ?? c.tipo}{c.origem === 'guarda_promessa' ? ' · aberto pela guarda de promessa' : ''}</div>
            <h2 className="mt-0.5 text-lg font-semibold text-slate-800">{c.titulo}</h2>
            <div className="text-sm text-slate-500">{c.familia?.nome_responsavel || 'Família'}{c.lead?.coluna?.nome ? ` · ${c.lead.coluna.nome}` : ''}</div>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${COR_ESTADO[c.estado]}`}>{ROTULO_ESTADO[c.estado]}</span>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <div><div className="text-xs font-medium text-slate-500">Resumo</div><p className="whitespace-pre-wrap text-slate-700">{c.resumo}</p></div>
          {c.motivo_bloqueio && <div><div className="text-xs font-medium text-slate-500">Por que a IA não resolveu</div><p className="whitespace-pre-wrap text-slate-700">{c.motivo_bloqueio}</p></div>}
          {c.nota_equipe && <div><div className="text-xs font-medium text-slate-500">Última nota da equipe</div><p className="whitespace-pre-wrap text-slate-700">{c.nota_equipe}</p></div>}
          {iaPausada && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">A IA está pausada neste contato: a decisão da equipe não será comunicada automaticamente.</p>}
          <Link href={`/chat?lead=${c.lead_id}`} className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
            <MessageSquare className="h-4 w-4" /> Abrir a conversa
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex border-b border-slate-100 text-sm">
          <button onClick={() => setAba('decidir')} className={`px-4 py-2.5 font-medium ${aba === 'decidir' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-slate-500'}`}>Decidir</button>
          <button onClick={() => setAba('ia')} className={`px-4 py-2.5 font-medium ${aba === 'ia' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-slate-500'}`}>Conversar com a IA</button>
        </div>
        <div className="p-5">
          {aba === 'decidir'
            ? <PainelDecisao caso={c} aoDecidir={() => { carregar(); aoMudar() }} />
            : <ChatInterno casoId={c.id} inicial={d.chat} />}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-3 text-sm font-medium text-slate-700">Linha do tempo</div>
        <ol className="space-y-2">
          {d.eventos.map((e) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
              <div>
                <span className="text-slate-700">{ROTULO_EVENTO[e.tipo] ?? e.tipo}</span>
                <span className="text-slate-400"> · {atorLegivel(e.ator, d.nomes)} · {dataHora(e.criado_em)}</span>
                {typeof e.detalhe?.nota === 'string' && <div className="text-slate-600">“{e.detalhe.nota}”</div>}
                {typeof e.detalhe?.informacao === 'string' && <div className="text-slate-600">“{e.detalhe.informacao}”</div>}
                {typeof e.detalhe?.motivo === 'string' && <div className="text-slate-500">{e.detalhe.motivo}</div>}
              </div>
            </li>
          ))}
        </ol>
        {c.contexto && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-slate-500">Conversa no momento da abertura</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{c.contexto}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

function PainelDecisao({ caso, aoDecidir }: { caso: Detalhe['caso']; aoDecidir: () => void }) {
  const [nota, setNota] = useState('')
  const [enviando, setEnviando] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  if (caso.estado !== 'aguardando_equipe') {
    return <p className="text-sm text-slate-500">
      {caso.estado === 'aguardando_familia'
        ? 'Aguardando a família responder o que vocês pediram. Quando ela responder, o Caso volta para cá e vocês recebem um aviso.'
        : `Caso ${ROTULO_ESTADO[caso.estado].toLowerCase()}. Nenhuma ação pendente.`}
    </p>
  }

  async function agir(acao: 'concluir' | 'pedir_info' | 'escalar') {
    if (acao === 'escalar' && !confirm('Passar para atendimento humano? A IA será pausada neste contato.')) return
    setEnviando(acao)
    setMsg(null)
    const r = await fetch(`/api/casos/${caso.id}/acao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acao, nota }),
    })
    const j = await r.json().catch(() => ({}))
    setEnviando(null)
    if (!r.ok) { setMsg(j.error || 'Erro'); return }
    setNota('')
    aoDecidir()
  }

  return (
    <div className="space-y-3">
      <textarea value={nota} onChange={(e) => setNota(e.target.value)} maxLength={4000} rows={4}
        placeholder="Escreva a resposta (para concluir) ou o que perguntar à família (para pedir informação). A IA repassa com as palavras dela."
        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
      <div className="flex flex-wrap gap-2">
        <button onClick={() => agir('concluir')} disabled={!!enviando || !nota.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
          {enviando === 'concluir' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Concluir
        </button>
        <button onClick={() => agir('pedir_info')} disabled={!!enviando || !nota.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50">
          {enviando === 'pedir_info' ? <Loader2 className="h-4 w-4 animate-spin" /> : <HelpCircle className="h-4 w-4" />} Pedir informação à família
        </button>
        <button onClick={() => agir('escalar')} disabled={!!enviando}
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50">
          {enviando === 'escalar' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRound className="h-4 w-4" />} Passar para humano
        </button>
      </div>
      {msg && <p className="text-sm text-red-600">{msg}</p>}
    </div>
  )
}

function ChatInterno({ casoId, inicial }: { casoId: string; inicial: Chat[] }) {
  const [msgs, setMsgs] = useState<Chat[]>(inicial)
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  async function enviar() {
    const pergunta = texto.trim()
    if (!pergunta || enviando) return
    const turnId = crypto.randomUUID()
    setEnviando(true)
    setErro(null)
    setMsgs((m) => [...m, { id: `u-${turnId}`, papel: 'user', conteudo: pergunta, criado_em: new Date().toISOString() }])
    setTexto('')
    const r = await fetch(`/api/casos/${casoId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pergunta, turn_id: turnId }),
    })
    const j = await r.json().catch(() => ({}))
    setEnviando(false)
    if (!r.ok) { setErro(j.error || 'Erro'); return }
    setMsgs((m) => [...m, { id: `a-${turnId}`, papel: 'assistant', conteudo: j.resposta, criado_em: new Date().toISOString() }])
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">Conversa interna: nada daqui vai para a família nem muda o Caso.</p>
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {msgs.map((m) => (
          <div key={m.id} className={`flex gap-2 text-sm ${m.papel === 'user' ? 'justify-end' : ''}`}>
            {m.papel === 'assistant' && <Bot className="mt-1 h-4 w-4 shrink-0 text-slate-400" />}
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 ${m.papel === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700'}`}>{m.conteudo}</div>
          </div>
        ))}
        {enviando && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3 w-3 animate-spin" /> Pensando...</div>}
      </div>
      <div className="flex gap-2">
        <input value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && enviar()}
          placeholder="Ex.: o que você sugere responder?" maxLength={2000}
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400" />
        <button onClick={enviar} disabled={enviando || !texto.trim()} className="rounded-lg bg-blue-600 px-3 py-2 text-white disabled:opacity-50"><Send className="h-4 w-4" /></button>
      </div>
      {erro && <p className="text-sm text-red-600">{erro}</p>}
    </div>
  )
}
