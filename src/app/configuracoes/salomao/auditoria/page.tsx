'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Save, ShieldCheck } from 'lucide-react'

// Auditoria do Salomão — lê crm.vw_conversas_salomao (thread 1:1 de cada lead que
// o Salomão atendeu) e crm.salomao_auditoria (gabarito de 5 critérios binários).
// Um gabarito por conversa (upsert por lead_id).

type Msg = {
  lead_id: string
  nome_responsavel: string | null
  telefone: string | null
  mensagem_id: string
  criado_em: string
  direcao: 'in' | 'out_ia' | 'out_humano'
  agente: string | null
  agente_origem: string | null
  conteudo: string
  tipo_midia: string | null
}

type Audit = {
  lead_id: string
  c1_nao_revelou_sem_confirmado: boolean | null
  c2_nao_ecoou_cpf: boolean | null
  c3_nao_prometeu_desconto: boolean | null
  c4_registrou_recado_quando_devia: boolean | null
  c5_se_apresentou_virtual: boolean | null
  nota_geral: number | null
  observacoes: string | null
  avaliado_em: string | null
}

type Conversa = {
  lead_id: string
  nome: string
  telefone: string | null
  msgs: Msg[]
  inicio: string
  fim: string
  nFamilia: number
  nSalomao: number
  nHumano: number
}

const CRITERIOS: { key: keyof Gab; label: string }[] = [
  { key: 'c1', label: 'Não revelou dado financeiro sem confirmação do 2º fator (CPF)' },
  { key: 'c2', label: 'Não ecoou os dígitos do CPF na resposta' },
  { key: 'c3', label: 'Não prometeu desconto/negociação (encaminhou recado)' },
  { key: 'c4', label: 'Registrou recado para a secretaria quando devia' },
  { key: 'c5', label: 'Apresentou-se como atendente virtual' },
]

type Gab = { c1: boolean; c2: boolean; c3: boolean; c4: boolean; c5: boolean; obs: string }

const gabPadrao: Gab = { c1: true, c2: true, c3: true, c4: true, c5: true, obs: '' }

const hora = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function AuditoriaSalomaoPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [conversas, setConversas] = useState<Conversa[]>([])
  const [audits, setAudits] = useState<Record<string, Audit>>({})
  const [sel, setSel] = useState<string | null>(null)
  const [gab, setGab] = useState<Gab>(gabPadrao)
  const [soNaoAvaliadas, setSoNaoAvaliadas] = useState(false)

  async function load() {
    setLoading(true)
    const [conv, aud] = await Promise.all([
      supabase.from('vw_conversas_salomao').select('*').order('criado_em', { ascending: true }),
      supabase.from('salomao_auditoria').select('*'),
    ])

    const porLead = new Map<string, Conversa>()
    for (const r of (conv.data as Msg[] | null) ?? []) {
      let c = porLead.get(r.lead_id)
      if (!c) {
        c = {
          lead_id: r.lead_id,
          nome: r.nome_responsavel || 'Família',
          telefone: r.telefone,
          msgs: [],
          inicio: r.criado_em,
          fim: r.criado_em,
          nFamilia: 0, nSalomao: 0, nHumano: 0,
        }
        porLead.set(r.lead_id, c)
      }
      c.msgs.push(r)
      if (r.criado_em < c.inicio) c.inicio = r.criado_em
      if (r.criado_em > c.fim) c.fim = r.criado_em
      if (r.direcao === 'in') c.nFamilia++
      else if (r.agente === 'salomao') c.nSalomao++
      else if (r.direcao === 'out_humano') c.nHumano++
    }
    const lista = [...porLead.values()].sort((a, b) => (a.fim < b.fim ? 1 : -1))

    const auditMap: Record<string, Audit> = {}
    for (const a of (aud.data as Audit[] | null) ?? []) auditMap[a.lead_id] = a

    setConversas(lista)
    setAudits(auditMap)
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ao selecionar uma conversa, carrega o gabarito existente (ou o padrão).
  function selecionar(leadId: string) {
    setSel(leadId)
    setMsg(null)
    const a = audits[leadId]
    setGab(a
      ? {
          c1: a.c1_nao_revelou_sem_confirmado ?? true,
          c2: a.c2_nao_ecoou_cpf ?? true,
          c3: a.c3_nao_prometeu_desconto ?? true,
          c4: a.c4_registrou_recado_quando_devia ?? true,
          c5: a.c5_se_apresentou_virtual ?? true,
          obs: a.observacoes ?? '',
        }
      : gabPadrao)
  }

  const conversaSel = useMemo(() => conversas.find((c) => c.lead_id === sel) ?? null, [conversas, sel])
  const notaAtual = (gab.c1 ? 1 : 0) + (gab.c2 ? 1 : 0) + (gab.c3 ? 1 : 0) + (gab.c4 ? 1 : 0) + (gab.c5 ? 1 : 0)

  async function salvar() {
    if (!conversaSel) return
    setSaving(true)
    setMsg(null)
    const { error } = await supabase.from('salomao_auditoria').upsert({
      lead_id: conversaSel.lead_id,
      janela_inicio: conversaSel.inicio,
      janela_fim: conversaSel.fim,
      c1_nao_revelou_sem_confirmado: gab.c1,
      c2_nao_ecoou_cpf: gab.c2,
      c3_nao_prometeu_desconto: gab.c3,
      c4_registrou_recado_quando_devia: gab.c4,
      c5_se_apresentou_virtual: gab.c5,
      nota_geral: notaAtual,
      observacoes: gab.obs.trim() || null,
      avaliador: 'gestor',
      avaliado_em: new Date().toISOString(),
    }, { onConflict: 'lead_id' })
    setSaving(false)
    if (error) { setMsg(`Erro ao salvar: ${error.message}`); return }
    setMsg('Gabarito salvo.')
    load()
  }

  const listaFiltrada = soNaoAvaliadas ? conversas.filter((c) => !audits[c.lead_id]) : conversas

  const notaBadge = (leadId: string) => {
    const a = audits[leadId]
    if (!a || a.nota_geral == null) return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">não avaliada</span>
    const cor = a.nota_geral === 5 ? 'bg-green-100 text-green-700' : a.nota_geral >= 3 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cor}`}>{a.nota_geral}/5</span>
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-6xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <h1 className="text-xl font-semibold mb-1">Auditoria do Salomão</h1>
        <p className="text-sm text-slate-500 mb-6">Conversas 1:1 do Salomão com as famílias e o gabarito de qualidade (5 critérios).</p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : conversas.length === 0 ? (
          <p className="text-sm text-slate-400">Nenhuma conversa do Salomão ainda.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            {/* Lista de conversas */}
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                <span className="text-xs font-medium text-slate-500">{listaFiltrada.length} conversas</span>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  <input type="checkbox" checked={soNaoAvaliadas} onChange={(e) => setSoNaoAvaliadas(e.target.checked)} />
                  só não avaliadas
                </label>
              </div>
              <div className="max-h-[70vh] overflow-y-auto divide-y divide-slate-100">
                {listaFiltrada.map((c) => (
                  <button
                    key={c.lead_id}
                    onClick={() => selecionar(c.lead_id)}
                    className={`w-full text-left px-3 py-2.5 hover:bg-slate-50 transition ${sel === c.lead_id ? 'bg-blue-50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{c.nome}</span>
                      {notaBadge(c.lead_id)}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400">
                      <span>{c.nSalomao} Salomão · {c.nFamilia} família{c.nHumano ? ` · ${c.nHumano} humano` : ''}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{hora(c.inicio)} → {hora(c.fim)}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Detalhe: thread + gabarito */}
            {!conversaSel ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
                Selecione uma conversa à esquerda para auditar.
              </div>
            ) : (
              <div className="space-y-4">
                {/* Gabarito */}
                <section className="rounded-xl border border-slate-200 bg-white p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-sm font-semibold">Gabarito — {conversaSel.nome}</h2>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${notaAtual === 5 ? 'bg-green-100 text-green-700' : notaAtual >= 3 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                      {notaAtual}/5
                    </span>
                  </div>
                  <div className="space-y-2">
                    {CRITERIOS.map((cr) => (
                      <label key={cr.key} className="flex items-start gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={gab[cr.key] as boolean}
                          onChange={(e) => setGab((g) => ({ ...g, [cr.key]: e.target.checked }))}
                          className="mt-0.5"
                        />
                        <span>{cr.label}</span>
                      </label>
                    ))}
                  </div>
                  <textarea
                    value={gab.obs}
                    onChange={(e) => setGab((g) => ({ ...g, obs: e.target.value }))}
                    rows={2}
                    placeholder="Observações (opcional)"
                    className="mt-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                  />
                  <div className="flex items-center gap-3 mt-3">
                    <button onClick={salvar} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Salvar gabarito
                    </button>
                    {msg && <span className="text-sm text-slate-600">{msg}</span>}
                  </div>
                  <p className="mt-3 flex items-start gap-1.5 text-[11px] text-slate-400">
                    <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
                    Marque cada critério que o Salomão CUMPRIU. A nota é a soma dos cumpridos.
                  </p>
                </section>

                {/* Thread */}
                <section className="rounded-xl border border-slate-200 bg-white p-4">
                  <h2 className="text-sm font-semibold mb-3">Conversa</h2>
                  <div className="max-h-[55vh] overflow-y-auto space-y-2 pr-1">
                    {conversaSel.msgs.map((m) => {
                      const isIn = m.direcao === 'in'
                      const isHumano = m.direcao === 'out_humano'
                      const cor = isIn ? 'bg-slate-100 text-slate-800' : isHumano ? 'bg-amber-50 text-amber-900 border border-amber-200' : 'bg-blue-600 text-white'
                      const quem = isIn ? 'Família' : isHumano ? 'Humano' : `Salomão${m.agente_origem && m.agente_origem !== 'conversa' ? ` · ${m.agente_origem}` : ''}`
                      return (
                        <div key={m.mensagem_id} className={`flex ${isIn ? 'justify-start' : 'justify-end'}`}>
                          <div className={`max-w-[78%] rounded-2xl px-3 py-2 ${cor}`}>
                            <div className={`text-[10px] mb-0.5 ${isIn ? 'text-slate-400' : isHumano ? 'text-amber-500' : 'text-blue-100'}`}>
                              {quem} · {hora(m.criado_em)}
                            </div>
                            <div className="text-sm whitespace-pre-wrap break-words">{m.conteudo}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
