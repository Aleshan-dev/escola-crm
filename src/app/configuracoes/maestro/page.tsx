'use client'

import { useEffect, useRef, useState } from 'react'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Send, ShieldCheck, Check, X, Sparkles, AlertTriangle, Code2, Copy, Stethoscope } from 'lucide-react'

// Chat com o MESTRE GUARDIÃO. O gestor conversa, o Maestro propõe mudanças
// concretas e NADA é aplicado sem um clique de confirmação (POST /aplicar).
// O Maestro só propõe; aplicar é decisão humana.

type EstadoProposta = 'pendente' | 'aplicando' | 'aplicada' | 'recusada' | 'erro'

interface Proposta {
  titulo: string
  descricao: string
  acao: unknown | null
  aplicavel: boolean
  rascunho_codigo?: { alvo: string; conteudo: string }
  estado?: EstadoProposta
  resultado?: string
  link?: string
}

const INSTRUCAO_ANALISE =
  'Analise o sistema inteiro pelo snapshot (alertas de coerência, sinais de qualidade, gaps recorrentes, leads parados) e me dê as melhorias mais importantes, priorizadas, cada uma como proposta.'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  propostas?: Proposta[]
}

const SUGESTOES = [
  'Como o sistema está organizado agora?',
  'O que o roteador decide para um lead novo?',
  'Desligue o follow-up automático por enquanto.',
  'Deixe a validação de saída do Maestro em modo ativo.',
]

// Render leve de markdown: **negrito** e quebras de linha (sem dependência nova).
function renderTexto(t: string) {
  return t.split('\n').map((linha, i) => {
    const partes = linha.split(/(\*\*[^*]+\*\*)/g)
    return (
      <span key={i}>
        {partes.map((p, j) =>
          p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : <span key={j}>{p}</span>
        )}
        {i < t.split('\n').length - 1 && <br />}
      </span>
    )
  })
}

export default function MaestroChatPage() {
  const [mensagens, setMensagens] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const fimRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [mensagens, carregando])

  async function enviar(texto?: string) {
    const conteudo = (texto ?? input).trim()
    if (!conteudo || carregando) return
    setErro(null)
    const novo: ChatMsg = { role: 'user', content: conteudo }
    const base = [...mensagens, novo]
    setMensagens(base)
    setInput('')
    setCarregando(true)
    try {
      const resp = await fetch('/api/maestro/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ historico: base.map((m) => ({ role: m.role, content: m.content })) }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data?.error || 'Falha ao falar com o Maestro.')
      const propostas: Proposta[] = Array.isArray(data.propostas)
        ? data.propostas.map((p: Proposta) => ({ ...p, estado: 'pendente' as EstadoProposta }))
        : []
      setMensagens((m) => [...m, { role: 'assistant', content: data.resposta || 'Pronto.', propostas }])
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro inesperado.')
    } finally {
      setCarregando(false)
    }
  }

  async function aplicar(msgIdx: number, propIdx: number) {
    const prop = mensagens[msgIdx]?.propostas?.[propIdx]
    if (!prop?.acao) return
    atualizarProposta(msgIdx, propIdx, { estado: 'aplicando' })
    try {
      const resp = await fetch('/api/maestro/aplicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acao: prop.acao }),
      })
      const data = await resp.json()
      atualizarProposta(msgIdx, propIdx, {
        estado: data.ok ? 'aplicada' : 'erro',
        resultado: data.mensagem,
        link: data.link,
      })
    } catch (e) {
      atualizarProposta(msgIdx, propIdx, { estado: 'erro', resultado: e instanceof Error ? e.message : 'Erro ao aplicar.' })
    }
  }

  function atualizarProposta(msgIdx: number, propIdx: number, patch: Partial<Proposta>) {
    setMensagens((msgs) =>
      msgs.map((m, i) => {
        if (i !== msgIdx || !m.propostas) return m
        return { ...m, propostas: m.propostas.map((p, j) => (j === propIdx ? { ...p, ...patch } : p)) }
      })
    )
  }

  const inputCls = 'flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400'

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full flex-1 flex flex-col">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <div className="flex items-center gap-2 mb-1">
          <div className="rounded-lg bg-indigo-50 p-2 text-indigo-600"><ShieldCheck className="w-5 h-5" /></div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold leading-tight">Mestre Guardião</h1>
            <p className="text-sm text-slate-500">Converse e dê instruções. Ele analisa, propõe; você aplica.</p>
          </div>
          <button
            onClick={() => enviar(INSTRUCAO_ANALISE)}
            disabled={carregando}
            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-60"
          >
            <Stethoscope className="w-4 h-4" /> Analisar sistema
          </button>
        </div>

        <p className="mt-2 mb-4 flex items-start gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-800">
          <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
          Nenhuma mudança acontece sozinha: o Maestro só <strong className="mx-1">propõe</strong>. As alterações só valem quando você clica em <strong className="mx-1">Aplicar</strong> — e prompt/modelo da Sara e do Salomão viram <strong className="mx-1">rascunho</strong>, que só entra no ar quando você publica na tela do agente. O que mora em código (travas de segurança, roteador) vem como <strong className="mx-1">rascunho</strong> para um dev aplicar e deployar.
        </p>

        {/* Conversa */}
        <div className="flex-1 space-y-4 overflow-y-auto">
          {mensagens.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-center">
              <Sparkles className="w-6 h-6 text-indigo-400 mx-auto mb-2" />
              <p className="text-sm text-slate-600 mb-3">Peça um diagnóstico ou uma reorganização. Exemplos:</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGESTOES.map((s) => (
                  <button key={s} onClick={() => enviar(s)} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {mensagens.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[85%] ${m.role === 'user' ? '' : 'w-full'}`}>
                <div className={`rounded-2xl px-4 py-2.5 text-sm ${m.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-700'}`}>
                  {renderTexto(m.content)}
                </div>

                {/* Propostas */}
                {m.propostas && m.propostas.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {m.propostas.map((p, j) => (
                      <div key={j} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-slate-800">{p.titulo}</span>
                              {!p.aplicavel && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
                                  <AlertTriangle className="w-3 h-3" /> Recomendação (exige código/deploy)
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-xs text-slate-500">{renderTexto(p.descricao)}</p>
                          </div>
                        </div>

                        {p.rascunho_codigo && (
                          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
                                <Code2 className="w-3.5 h-3.5" /> Rascunho de código · {p.rascunho_codigo.alvo}
                              </span>
                              <button
                                onClick={() => navigator.clipboard?.writeText(p.rascunho_codigo!.conteudo)}
                                className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 hover:text-slate-700"
                              >
                                <Copy className="w-3 h-3" /> Copiar
                              </button>
                            </div>
                            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] leading-relaxed text-slate-700">{p.rascunho_codigo.conteudo}</pre>
                            <p className="mt-1.5 text-[10px] text-slate-400">Vive em código: aprove e peça ao desenvolvedor aplicar + deployar. Não entra sozinho.</p>
                          </div>
                        )}

                        {p.aplicavel && (
                          <div className="mt-3 flex items-center gap-2">
                            {p.estado === 'aplicada' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                                <Check className="w-4 h-4" /> Aplicado{p.resultado ? ` · ${p.resultado}` : ''}
                                {p.link && (
                                  <Link href={p.link} className="ml-1 text-indigo-600 underline hover:text-indigo-800">Revisar e publicar</Link>
                                )}
                              </span>
                            ) : p.estado === 'recusada' ? (
                              <span className="inline-flex items-center gap-1 text-xs text-slate-400"><X className="w-4 h-4" /> Recusado</span>
                            ) : p.estado === 'erro' ? (
                              <>
                                <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600"><AlertTriangle className="w-4 h-4" /> {p.resultado || 'Falhou'}</span>
                                <button onClick={() => aplicar(i, j)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300">Tentar de novo</button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => aplicar(i, j)}
                                  disabled={p.estado === 'aplicando'}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
                                >
                                  {p.estado === 'aplicando' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                                  Aplicar
                                </button>
                                <button
                                  onClick={() => atualizarProposta(i, j, { estado: 'recusada' })}
                                  disabled={p.estado === 'aplicando'}
                                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:border-slate-300"
                                >
                                  Recusar
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {carregando && (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" /> O Maestro está pensando...
              </div>
            </div>
          )}
          <div ref={fimRef} />
        </div>

        {erro && <p className="mt-2 text-sm text-red-600">{erro}</p>}

        {/* Entrada */}
        <form
          onSubmit={(e) => { e.preventDefault(); enviar() }}
          className="mt-4 flex items-end gap-2 border-t border-slate-200 pt-4"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar() } }}
            rows={1}
            placeholder="Dê uma instrução ao Maestro... (Enter envia, Shift+Enter quebra linha)"
            className={`${inputCls} resize-none`}
          />
          <button
            type="submit"
            disabled={carregando || !input.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            <Send className="w-4 h-4" /> Enviar
          </button>
        </form>
      </div>
    </div>
  )
}
