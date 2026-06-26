'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Save, Plus, Trash2 } from 'lucide-react'

const CATEGORIAS = ['institucional', 'metodologia', 'precos', 'rotinas', 'faq', 'objecoes']

type Conhecimento = {
  id: string
  categoria: string
  pergunta: string
  resposta: string
  ativa: boolean
}

export default function SaraConfigPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [nomeAgente, setNomeAgente] = useState('')
  const [modelo, setModelo] = useState('')
  const [informaPreco, setInformaPreco] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState('')

  const [kb, setKb] = useState<Conhecimento[]>([])
  const [novaCat, setNovaCat] = useState('faq')
  const [novaPerg, setNovaPerg] = useState('')
  const [novaResp, setNovaResp] = useState('')

  async function load() {
    setLoading(true)
    const [cfg, base] = await Promise.all([
      supabase.from('config_ia').select('*').eq('id', 1).single(),
      supabase.from('base_conhecimento').select('*').order('categoria'),
    ])
    const c = cfg.data as { nome_agente?: string; modelo?: string; informa_preco?: boolean; system_prompt?: string } | null
    if (c) {
      setNomeAgente(c.nome_agente || '')
      setModelo(c.modelo || '')
      setInformaPreco(!!c.informa_preco)
      setSystemPrompt(c.system_prompt || '')
    }
    if (base.data) setKb(base.data as unknown as Conhecimento[])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function salvarConfig() {
    setSaving(true)
    setMsg(null)
    const { error } = await supabase
      .from('config_ia')
      .update({
        nome_agente: nomeAgente.trim(),
        modelo: modelo.trim(),
        informa_preco: informaPreco,
        system_prompt: systemPrompt,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', 1)
    setSaving(false)
    setMsg(error ? `Erro ao salvar: ${error.message}` : 'Configurações salvas com sucesso.')
  }

  async function adicionarConhecimento() {
    if (!novaPerg.trim() || !novaResp.trim()) {
      setMsg('Preencha pergunta e resposta.')
      return
    }
    const { error } = await supabase.from('base_conhecimento').insert({
      categoria: novaCat,
      pergunta: novaPerg.trim(),
      resposta: novaResp.trim(),
      ativa: true,
    })
    if (error) { setMsg(`Erro: ${error.message}`); return }
    setNovaPerg('')
    setNovaResp('')
    load()
  }

  async function alternarAtiva(item: Conhecimento) {
    await supabase.from('base_conhecimento').update({ ativa: !item.ativa }).eq('id', item.id)
    load()
  }

  async function remover(id: string) {
    await supabase.from('base_conhecimento').delete().eq('id', id)
    load()
  }

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <h1 className="text-xl font-semibold mb-1">Comportamento da Sara</h1>
        <p className="text-sm text-slate-500 mb-6">Defina como a assistente atende as famílias.</p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="space-y-8">
            <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Nome do agente</span>
                  <input value={nomeAgente} onChange={(e) => setNomeAgente(e.target.value)} className={inputCls} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Modelo</span>
                  <input value={modelo} onChange={(e) => setModelo(e.target.value)} className={inputCls} placeholder="gpt-4o" />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={informaPreco} onChange={(e) => setInformaPreco(e.target.checked)} />
                Informar preço no WhatsApp
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Prompt do sistema (regras de atendimento)</span>
                <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={16} className={`${inputCls} font-mono text-xs leading-relaxed`} />
              </label>
              <div className="flex items-center gap-3">
                <button onClick={salvarConfig} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Salvar
                </button>
                {msg && <span className="text-sm text-slate-600">{msg}</span>}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold mb-3">Base de conhecimento</h2>
              <div className="space-y-2 mb-4">
                {kb.length === 0 && <p className="text-sm text-slate-400">Nenhum item cadastrado.</p>}
                {kb.map((item) => (
                  <div key={item.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{item.categoria}</span>
                      <div className="flex items-center gap-2">
                        <button onClick={() => alternarAtiva(item)} className={`text-[11px] px-2 py-0.5 rounded-full ${item.ativa ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                          {item.ativa ? 'Ativa' : 'Inativa'}
                        </button>
                        <button onClick={() => remover(item.id)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </div>
                    <p className="text-sm font-medium mt-1.5">{item.pergunta}</p>
                    <p className="text-sm text-slate-600">{item.resposta}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-lg bg-slate-50 p-3 space-y-2">
                <div className="grid sm:grid-cols-[160px_1fr] gap-2">
                  <select value={novaCat} onChange={(e) => setNovaCat(e.target.value)} className={inputCls}>
                    {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input value={novaPerg} onChange={(e) => setNovaPerg(e.target.value)} placeholder="Pergunta" className={inputCls} />
                </div>
                <textarea value={novaResp} onChange={(e) => setNovaResp(e.target.value)} rows={2} placeholder="Resposta" className={inputCls} />
                <button onClick={adicionarConhecimento} className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900">
                  <Plus className="w-4 h-4" /> Adicionar
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
