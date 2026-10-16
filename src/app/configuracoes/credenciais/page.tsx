'use client'

import { useEffect, useState } from 'react'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'

// Provedores predefinidos (espelha lib/ia-credenciais.ts). A tela sempre mostra
// todos os grupos; você só cola a chave no provedor que usar.
const PROVEDORES = [
  { id: 'anthropic', nome: 'Anthropic (Claude)', dica: 'Modelos: claude-3-5-sonnet-latest, claude-3-5-haiku-latest…' },
  { id: 'openai', nome: 'OpenAI (GPT)', dica: 'Modelos: gpt-4o, gpt-4o-mini…' },
  { id: 'gemini', nome: 'Google (Gemini)', dica: 'Modelos: gemini-2.0-flash, gemini-1.5-flash… (endpoint compatível-OpenAI do Google)' },
  { id: 'openrouter', nome: 'OpenRouter', dica: 'Modelos: openai/gpt-4o, anthropic/claude-3.5-sonnet, google/gemini-2.0-flash…' },
  { id: 'deepseek', nome: 'DeepSeek', dica: 'Modelos: deepseek-chat…' },
  { id: 'requesty', nome: 'Requesty', dica: 'Roteador compatível com OpenAI.' },
  { id: 'custom', nome: 'Compatível com OpenAI (custom)', dica: 'Qualquer endpoint compatível com a API da OpenAI (informe a baseURL).' },
]
const nomeProvedor = (id: string) => PROVEDORES.find((p) => p.id === id)?.nome || id

type Cred = {
  id: string
  provedor: string
  nome: string | null
  ultimos4: string | null
  validada: boolean
  erro_validacao: string | null
  em_uso_por: number
}

export default function CredenciaisPage() {
  const [loading, setLoading] = useState(true)
  const [creds, setCreds] = useState<Cred[]>([])
  const [modal, setModal] = useState(false)
  const [provedor, setProvedor] = useState('anthropic')
  const [nome, setNome] = useState('')
  const [chave, setChave] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/credenciais')
      const j = await r.json()
      setCreds(j.credenciais || [])
    } finally {
      setLoading(false)
    }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  function abrirModal(prov: string) {
    setProvedor(prov); setNome(''); setChave(''); setBaseUrl(''); setErro(null); setModal(true)
  }

  async function salvar() {
    setSalvando(true)
    setErro(null)
    try {
      const r = await fetch('/api/credenciais', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provedor, nome, api_key: chave, base_url: baseUrl }),
      })
      const j = await r.json()
      if (!r.ok) { setErro(j.error || 'Erro ao salvar'); return }
      setModal(false)
      await load()
    } finally {
      setSalvando(false)
    }
  }

  async function revalidar(id: string) {
    await fetch(`/api/credenciais/${id}`, { method: 'POST' })
    await load()
  }
  async function remover(id: string) {
    if (!confirm('Remover esta credencial? Agentes que a usam voltam para a chave padrão (env).')) return
    await fetch(`/api/credenciais/${id}`, { method: 'DELETE' })
    await load()
  }

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold mb-1">Chaves de acesso à IA</h1>
            <p className="text-sm text-slate-500">
              Cadastre a chave de cada provedor e escolha, na config de cada agente, por qual credencial ele
              responde. A chave fica só no servidor — a tela mostra apenas os 4 últimos dígitos.
            </p>
          </div>
          <button onClick={() => abrirModal('anthropic')} className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Plus className="w-4 h-4" /> Adicionar credencial
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="space-y-6">
            {PROVEDORES.map((prov) => {
              const doProv = creds.filter((c) => c.provedor === prov.id)
              return (
                <section key={prov.id}>
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-semibold text-slate-700">{prov.nome}</h2>
                    <button onClick={() => abrirModal(prov.id)} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                      <Plus className="w-3.5 h-3.5" /> Adicionar
                    </button>
                  </div>
                  {doProv.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-3 text-xs text-slate-400">
                      Nenhuma credencial. {prov.dica}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {doProv.map((c) => (
                        <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{c.nome || nomeProvedor(c.provedor)}</span>
                              {c.validada ? (
                                <span className="inline-flex items-center gap-1 text-[11px] text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle2 className="w-3 h-3" /> Validada</span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[11px] text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><AlertCircle className="w-3 h-3" /> Falhou</span>
                              )}
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">…{c.ultimos4 || '????'} · em uso por {c.em_uso_por}</div>
                            {!c.validada && c.erro_validacao && <div className="text-[11px] text-red-600 mt-1 truncate">{c.erro_validacao}</div>}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button onClick={() => revalidar(c.id)} title="Revalidar" className="text-slate-400 hover:text-blue-600"><RefreshCw className="w-4 h-4" /></button>
                            <button onClick={() => remover(c.id)} title="Remover" className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-1">Adicionar credencial</h2>
            <p className="text-sm text-slate-500 mb-4">A chave é guardada só no servidor. Depois de salva, só os 4 últimos dígitos aparecem.</p>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Provedor</span>
                <select value={provedor} onChange={(e) => setProvedor(e.target.value)} className={inputCls}>
                  {PROVEDORES.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                </select>
                <span className="mt-1 block text-[11px] text-slate-400">{PROVEDORES.find((p) => p.id === provedor)?.dica}</span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Nome (opcional)</span>
                <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="ex.: Chave da escola" className={inputCls} />
              </label>
              {provedor === 'custom' && (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Base URL (compatível com OpenAI)</span>
                  <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." className={inputCls} />
                </label>
              )}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Chave</span>
                <input value={chave} onChange={(e) => setChave(e.target.value)} placeholder="sk-..." className={inputCls} type="password" autoComplete="off" />
              </label>
              {erro && <div className="text-sm text-red-600">{erro}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button onClick={() => setModal(false)} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
              <button onClick={salvar} disabled={salvando || !chave.trim()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Salvar e validar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
