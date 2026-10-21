'use client'

// Versionamento da configuração da Sara/Salomão (padrão DeskcommCRM):
// editar → rascunho (não afeta produção) → testar → publicar (vN) → histórico/rollback.
// A tela do agente só desenha os campos; estado, ações e histórico vêm daqui.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import {
  diffLinhas, diffSnapshots, snapshotsIguais, ROTULOS, type Agente, type DiffCampo, type Snapshot,
} from '@/lib/agente-versoes/regras'
import type { EstadoAgente, Versao } from '@/lib/agente-versoes/servico'
import { Loader2, Save, Rocket, Undo2, History, FlaskConical, ChevronDown, ChevronRight, Trash2 } from 'lucide-react'

const ORIGEM: Record<string, string> = { tela: 'tela', maestro: 'Maestro', restauracao: 'restauração', baseline: 'baseline' }

function quando(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

export function useVersoesAgente(agente: Agente) {
  const [estado, setEstado] = useState<EstadoAgente | null>(null)
  const [form, setForm] = useState<Snapshot>({})
  const [ocupado, setOcupado] = useState<null | 'salvar' | 'publicar' | 'descartar' | 'restaurar'>(null)
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null)

  const aplicarEstado = useCallback((e: EstadoAgente) => {
    setEstado(e)
    setForm(e.editor)
  }, [])

  useEffect(() => {
    let vivo = true
    fetch(`/api/agentes/${agente}/versoes`, { cache: 'no-store' })
      .then(async (r) => ({ ok: r.ok, d: await r.json() }))
      .then(({ ok, d }) => {
        if (!vivo) return
        if (!ok) setMsg({ tipo: 'erro', texto: d.error || 'Erro ao carregar versões' })
        else aplicarEstado(d)
      })
      .catch(() => vivo && setMsg({ tipo: 'erro', texto: 'Erro ao carregar versões' }))
    return () => { vivo = false }
  }, [agente, aplicarEstado])

  async function acao(nome: 'salvar' | 'publicar' | 'descartar' | 'restaurar', extra: Record<string, unknown> = {}, ok?: string) {
    setOcupado(nome)
    setMsg(null)
    try {
      const r = await fetch(`/api/agentes/${agente}/versoes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acao: nome, ...extra }),
      })
      const d = await r.json()
      if (!r.ok) { setMsg({ tipo: 'erro', texto: d.error || 'Erro' }); return false }
      aplicarEstado(d)
      if (ok) setMsg({ tipo: 'ok', texto: ok })
      return true
    } finally {
      setOcupado(null)
    }
  }

  const sujo = !!estado && !snapshotsIguais(agente, form, estado.editor)
  const set = (campo: string, valor: string | boolean | null) => setForm((f) => ({ ...f, [campo]: valor }))

  return {
    estado, form, set, sujo, ocupado, msg,
    salvar: () => acao('salvar', { snapshot: form }, 'Rascunho salvo. Produção não foi alterada.'),
    publicar: async (nota: string) => {
      // Edição não salva entra no rascunho antes de publicar.
      if (sujo && !(await acao('salvar', { snapshot: form }))) return
      await acao('publicar', { nota }, 'Publicado — já está no ar.')
    },
    descartar: () => acao('descartar', {}, 'Rascunho descartado.'),
    restaurar: (v: Versao) => acao('restaurar', { versao_id: v.id }, `v${v.versao} restaurada — já está no ar.`),
  }
}

type Hook = ReturnType<typeof useVersoesAgente>

export function AbasVersao({ aba, setAba, total }: { aba: 'config' | 'historico'; setAba: (a: 'config' | 'historico') => void; total: number }) {
  const cls = (on: boolean) =>
    `px-3 py-2 text-sm border-b-2 -mb-px ${on ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-slate-500 hover:text-slate-700'}`
  return (
    <div className="flex gap-2 border-b border-slate-200 mb-5">
      <button className={cls(aba === 'config')} onClick={() => setAba('config')}>Configuração</button>
      <button className={cls(aba === 'historico')} onClick={() => setAba('historico')}>
        <span className="inline-flex items-center gap-1"><History className="w-4 h-4" /> Histórico{total ? ` (${total})` : ''}</span>
      </button>
    </div>
  )
}

/** Faixa de status + Salvar rascunho / Publicar / Descartar. */
export function BarraRascunho({ agente, v }: { agente: Agente; v: Hook }) {
  const [nota, setNota] = useState('')
  const [verDiff, setVerDiff] = useState(false)
  const { estado } = v
  const diff = useMemo(() => (estado ? diffSnapshots(agente, estado.noAr, v.form) : []), [agente, estado, v.form])
  if (!estado) return null
  const temMudanca = diff.length > 0
  const pub = estado.publicada

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        No ar: <strong className="text-slate-700">{pub ? `v${pub.versao}` : 'sem versão'}</strong>
        {pub && <> · publicada {quando(pub.publicado_em)}{pub.publicado_por ? ` por ${pub.publicado_por}` : ''}</>}
      </div>

      {temMudanca && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-center justify-between gap-2">
            <span>
              {v.sujo ? 'Alterações não salvas' : 'Rascunho salvo'} — {diff.length} campo(s) diferente(s) do que está no ar.
              {estado.rascunho?.origem === 'maestro' && !v.sujo && ' Proposto pelo Maestro.'} Produção não muda até publicar.
            </span>
            <button onClick={() => setVerDiff((x) => !x)} className="text-xs underline shrink-0">{verDiff ? 'Ocultar' : 'Ver'} diferenças</button>
          </div>
          {verDiff && <div className="mt-3"><ListaDiff diff={diff} /></div>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={v.salvar} disabled={!v.sujo || !!v.ocupado}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {v.ocupado === 'salvar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Salvar rascunho
        </button>
        <input
          value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Nota da versão (opcional)"
          className="flex-1 min-w-[160px] rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
        />
        <button
          onClick={async () => {
            if (!confirm(`Publicar a configuração do ${agente === 'sara' ? 'Sara' : 'Salomão'}? Ela passa a valer na hora para as famílias.`)) return
            await v.publicar(nota)
            setNota('')
          }}
          disabled={!temMudanca || !!v.ocupado}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {v.ocupado === 'publicar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
          Publicar
        </button>
        {estado.rascunho && (
          <button
            onClick={() => { if (confirm('Descartar o rascunho? A edição volta ao que está no ar.')) v.descartar() }}
            disabled={!!v.ocupado}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-slate-500 hover:text-red-600 disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" /> Descartar
          </button>
        )}
      </div>
      {v.msg && <p className={`text-sm ${v.msg.tipo === 'erro' ? 'text-red-600' : 'text-emerald-700'}`}>{v.msg.texto}</p>}
    </div>
  )
}

function valorCurto(x: string | boolean | null) {
  if (x === null || x === '') return '(vazio)'
  if (typeof x === 'boolean') return x ? 'sim' : 'não'
  return x.length > 80 ? x.slice(0, 80) + '…' : x
}

function ListaDiff({ diff }: { diff: DiffCampo[] }) {
  if (diff.length === 0) return <p className="text-xs text-slate-400">Sem diferenças.</p>
  return (
    <div className="space-y-2">
      {diff.map((d) => {
        const longo = typeof d.antes === 'string' && d.antes.includes('\n') || typeof d.depois === 'string' && d.depois.includes('\n')
        if (!longo) {
          return (
            <div key={d.campo} className="text-xs">
              <span className="font-medium text-slate-700">{d.rotulo}:</span>{' '}
              <span className="line-through text-red-600">{valorCurto(d.antes)}</span> → <span className="text-emerald-700">{valorCurto(d.depois)}</span>
            </div>
          )
        }
        return <DiffTexto key={d.campo} rotulo={d.rotulo} antes={d.antes as string | null} depois={d.depois as string | null} />
      })}
    </div>
  )
}

function DiffTexto({ rotulo, antes, depois }: { rotulo: string; antes: string | null; depois: string | null }) {
  const linhas = useMemo(() => diffLinhas(antes, depois), [antes, depois])
  // Mostra só os trechos alterados com 2 linhas de contexto.
  const mostrar = linhas.map((l, i) => l.tipo !== 'igual' || linhas.slice(Math.max(0, i - 2), i + 3).some((x) => x.tipo !== 'igual'))
  const add = linhas.filter((l) => l.tipo === 'add').length
  const del = linhas.filter((l) => l.tipo === 'del').length
  return (
    <div className="text-xs">
      <div className="font-medium text-slate-700 mb-1">{rotulo} <span className="text-emerald-700">+{add}</span> <span className="text-red-600">−{del}</span></div>
      <pre className="max-h-80 overflow-auto rounded border border-slate-200 bg-white font-mono text-[11px] leading-relaxed">
        {linhas.map((l, i) => {
          if (!mostrar[i]) return mostrar[i - 1] ? <div key={i} className="px-2 text-slate-300">⋯</div> : null
          const cor = l.tipo === 'add' ? 'bg-emerald-50 text-emerald-800' : l.tipo === 'del' ? 'bg-red-50 text-red-700' : 'text-slate-500'
          return <div key={i} className={`px-2 whitespace-pre-wrap ${cor}`}>{l.tipo === 'add' ? '+ ' : l.tipo === 'del' ? '− ' : '  '}{l.texto}</div>
        })}
      </pre>
    </div>
  )
}

/** Testa a edição atual (mesmo sem salvar) contra a conversa de um lead real. Não envia nada. */
export function TestarRascunho({ agente, v }: { agente: Agente; v: Hook }) {
  const supabase = createClient()
  const [leads, setLeads] = useState<{ id: string; nome: string }[]>([])
  const [leadId, setLeadId] = useState('')
  const [comparar, setComparar] = useState(false)
  const [rodando, setRodando] = useState(false)
  const [res, setRes] = useState<{ rascunho?: string; noAr?: string; erro?: string } | null>(null)

  useEffect(() => {
    supabase
      .from('leads')
      .select('id, familia:familias(nome_responsavel), crianca:criancas(nome)')
      .order('atualizado_em', { ascending: false })
      .limit(50)
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as { id: string; familia?: { nome_responsavel?: string } | null; crianca?: { nome?: string } | null }[]
        setLeads(rows.map((l) => ({
          id: l.id,
          nome: [l.familia?.nome_responsavel, l.crianca?.nome && `(${l.crianca.nome})`].filter(Boolean).join(' ') || l.id.slice(0, 8),
        })))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function rodar(snapshot: Snapshot) {
    const r = await fetch(`/api/agentes/${agente}/testar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: leadId, snapshot }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Erro ao testar')
    return `${d.resposta}${d.transbordo ? '\n\n[pediria atendimento humano]' : ''}`
  }

  async function testar() {
    if (!leadId || !v.estado) return
    setRodando(true)
    setRes(null)
    try {
      const [rascunho, noAr] = await Promise.all([rodar(v.form), comparar ? rodar(v.estado.noAr) : Promise.resolve(undefined)])
      setRes({ rascunho, noAr })
    } catch (e) {
      setRes({ erro: e instanceof Error ? e.message : 'Erro' })
    } finally {
      setRodando(false)
    }
  }

  const inputCls = 'rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-1.5"><FlaskConical className="w-4 h-4" /> Testar antes de publicar</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Gera a resposta que o {agente === 'sara' ? 'Sara' : 'Salomão'} daria agora na conversa do lead escolhido, com a configuração em edição.
          Não envia nada à família. Usa a IA (tem custo).
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={`${inputCls} flex-1 min-w-[200px]`}>
          <option value="">Escolha um lead…</option>
          {leads.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={comparar} onChange={(e) => setComparar(e.target.checked)} /> comparar com o que está no ar
        </label>
        <button onClick={testar} disabled={!leadId || rodando} className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50">
          {rodando ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />} Testar
        </button>
      </div>
      {res?.erro && <p className="text-sm text-red-600">{res.erro}</p>}
      {res && !res.erro && (
        <div className={`grid gap-3 ${res.noAr !== undefined ? 'sm:grid-cols-2' : ''}`}>
          <div>
            <div className="text-[11px] font-medium text-amber-700 mb-1">Com a edição atual</div>
            <p className="whitespace-pre-wrap rounded-lg bg-amber-50 p-3 text-sm text-slate-800">{res.rascunho}</p>
          </div>
          {res.noAr !== undefined && (
            <div>
              <div className="text-[11px] font-medium text-slate-500 mb-1">Com o que está no ar</div>
              <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800">{res.noAr}</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Lista de versões publicadas, diff com a anterior e "Voltar para esta versão". */
export function HistoricoVersoes({ agente, v }: { agente: Agente; v: Hook }) {
  const [aberta, setAberta] = useState<string | null>(null)
  const versoes = v.estado?.versoes ?? []
  if (!v.estado) return <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
  if (versoes.length === 0) return <p className="text-sm text-slate-400">Nenhuma versão publicada ainda.</p>

  return (
    <div className="space-y-2">
      {v.msg && <p className={`text-sm ${v.msg.tipo === 'erro' ? 'text-red-600' : 'text-emerald-700'}`}>{v.msg.texto}</p>}
      {versoes.map((ver, i) => {
        const anterior = versoes[i + 1]
        const diff = anterior ? diffSnapshots(agente, anterior.snapshot, ver.snapshot) : []
        const open = aberta === ver.id
        return (
          <div key={ver.id} className="rounded-xl border border-slate-200 bg-white">
            <button onClick={() => setAberta(open ? null : ver.id)} className="w-full flex items-center gap-3 p-3 text-left">
              {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              <span className="font-semibold text-sm w-10">v{ver.versao}</span>
              {ver.status === 'publicada'
                ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">no ar</span>
                : <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">arquivada</span>}
              <span className="text-xs text-slate-500 flex-1 truncate">
                {quando(ver.publicado_em)}{ver.publicado_por ? ` · ${ver.publicado_por}` : ''} · {ORIGEM[ver.origem] ?? ver.origem}
                {ver.nota ? ` · ${ver.nota}` : ''}
              </span>
              <span className="text-[11px] text-slate-400 shrink-0">
                {anterior ? (diff.length ? diff.map((d) => ROTULOS[d.campo] ?? d.campo).join(', ') : 'sem mudanças') : 'versão inicial'}
              </span>
            </button>
            {open && (
              <div className="border-t border-slate-100 p-3 space-y-3">
                {anterior
                  ? <><p className="text-xs text-slate-500">Mudanças em relação à v{anterior.versao}:</p><ListaDiff diff={diff} /></>
                  : <p className="text-xs text-slate-500">Primeira versão registrada (configuração que estava em produção).</p>}
                {ver.status === 'arquivada' && (
                  <button
                    onClick={() => {
                      if (confirm(`Voltar para a v${ver.versao}? Ela vira uma nova versão publicada e passa a valer na hora.`)) v.restaurar(ver)
                    }}
                    disabled={!!v.ocupado}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {v.ocupado === 'restaurar' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
                    Voltar para esta versão
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
