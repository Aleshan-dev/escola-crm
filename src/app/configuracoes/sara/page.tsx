'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react'
import { AbasVersao, BarraRascunho, HistoricoVersoes, TestarRascunho, useVersoesAgente } from '@/components/agentes/Versionamento'

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
  const [msg, setMsg] = useState<string | null>(null)
  const [aba, setAba] = useState<'config' | 'historico'>('config')

  // Nome, modelo, credencial, preço e prompt são VERSIONADOS: editar grava
  // rascunho; só "Publicar" leva para config_ia (produção).
  const v = useVersoesAgente('sara')
  const f = v.form
  const [credenciais, setCredenciais] = useState<{ id: string; provedor: string; nome: string | null; ultimos4: string | null }[]>([])

  const [kb, setKb] = useState<Conhecimento[]>([])
  const [novaCat, setNovaCat] = useState('faq')
  const [novaPerg, setNovaPerg] = useState('')
  const [novaResp, setNovaResp] = useState('')

  async function load() {
    setLoading(true)
    const [base, credsResp] = await Promise.all([
      supabase.from('base_conhecimento').select('*').order('categoria'),
      fetch('/api/credenciais').then((r) => r.json()).catch(() => ({ credenciais: [] })),
    ])
    if (base.data) setKb(base.data as unknown as Conhecimento[])
    setCredenciais(credsResp?.credenciais || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        <p className="text-sm text-slate-500 mb-4">Defina como a assistente atende as famílias.</p>

        <AbasVersao aba={aba} setAba={setAba} total={v.estado?.versoes.length ?? 0} />

        {aba === 'historico' ? (
          <HistoricoVersoes agente="sara" v={v} />
        ) : loading || !v.estado ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="space-y-8">
            <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Nome do agente</span>
                  <input value={(f.nome_agente as string) ?? ''} onChange={(e) => v.set('nome_agente', e.target.value)} className={inputCls} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-slate-500">Modelo</span>
                  <input value={(f.modelo as string) ?? ''} onChange={(e) => v.set('modelo', e.target.value)} className={inputCls} placeholder="gpt-4o" />
                </label>
              </div>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Credencial de IA</span>
                <select value={(f.sara_credencial_id as string) ?? ''} onChange={(e) => v.set('sara_credencial_id', e.target.value || null)} className={inputCls}>
                  <option value="">Padrão (chave do ambiente)</option>
                  {credenciais.map((c) => (
                    <option key={c.id} value={c.id}>{(c.nome || c.provedor) + ' · …' + (c.ultimos4 || '')}</option>
                  ))}
                </select>
                <Link href="/configuracoes/credenciais" className="text-xs text-blue-600 hover:underline mt-1 inline-block">Gerenciar credenciais</Link>
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={f.informa_preco === true} onChange={(e) => v.set('informa_preco', e.target.checked)} />
                Informar preço no WhatsApp
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Prompt do sistema (regras de atendimento)</span>
                <textarea value={(f.system_prompt as string) ?? ''} onChange={(e) => v.set('system_prompt', e.target.value)} rows={16} className={`${inputCls} font-mono text-xs leading-relaxed`} />
              </label>
              <BarraRascunho agente="sara" v={v} />
            </section>

            <TestarRascunho agente="sara" v={v} />

            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-semibold">Base de conhecimento</h2>
              <p className="text-xs text-slate-500 mb-3">Não é versionada: incluir, ativar ou remover vale na hora.</p>
              {msg && <p className="text-sm text-red-600 mb-2">{msg}</p>}
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
