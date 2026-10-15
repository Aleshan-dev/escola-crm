'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Save, ShieldCheck } from 'lucide-react'

// Comportamento do Salomão — atendente de FAMÍLIAS MATRICULADAS (irmão da Sara).
// Só o preâmbulo de persona (tom/identidade) é editável aqui; as travas de
// segurança (2º fator do CPF, LGPD) e o formato JSON ficam no código (salomao.ts).

export default function SalomaoConfigPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [ativo, setAtivo] = useState(false)
  const [modelo, setModelo] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [canaisPagamento, setCanaisPagamento] = useState('')

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('config_ia').select('*').eq('id', 1).single()
    const c = data as {
      salomao_ativo?: boolean
      salomao_modelo?: string
      salomao_system_prompt?: string
      salomao_canais_pagamento?: string
    } | null
    if (c) {
      setAtivo(!!c.salomao_ativo)
      setModelo(c.salomao_modelo || '')
      setSystemPrompt(c.salomao_system_prompt || '')
      setCanaisPagamento(c.salomao_canais_pagamento || '')
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function salvar() {
    setSaving(true)
    setMsg(null)
    const { error } = await supabase
      .from('config_ia')
      .update({
        salomao_ativo: ativo,
        salomao_modelo: modelo.trim() || null,
        salomao_system_prompt: systemPrompt.trim() || null,
        salomao_canais_pagamento: canaisPagamento.trim() || null,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', 1)
    setSaving(false)
    setMsg(error ? `Erro ao salvar: ${error.message}` : 'Configurações salvas com sucesso.')
  }

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <h1 className="text-xl font-semibold mb-1">Comportamento do Salomão</h1>
        <p className="text-sm text-slate-500 mb-6">Atendente das famílias já matriculadas (financeiro, 2ª via, recados).</p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="space-y-8">
            <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              {/* Kill switch */}
              <div className="rounded-lg border border-slate-200 p-3">
                <label className="flex items-start gap-3 text-sm text-slate-700">
                  <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="font-medium">Salomão ativo</span>
                    <span className="block text-xs text-slate-500 mt-0.5">
                      Ligado, o Salomão atende automaticamente as famílias matriculadas no WhatsApp.
                      Desligado, o comportamento é o legado: a IA pausa e o atendimento vai para um humano.
                    </span>
                  </span>
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Modelo</span>
                <input value={modelo} onChange={(e) => setModelo(e.target.value)} className={inputCls} placeholder="gpt-4o (vazio = usa o modelo da Sara)" />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Preâmbulo de persona (tom e identidade)</span>
                <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={12} className={`${inputCls} font-mono text-xs leading-relaxed`} placeholder="Vazio = usa o texto padrão do código." />
                <span className="mt-1.5 flex items-start gap-1.5 text-[11px] text-slate-500">
                  <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
                  Por segurança, as travas de 2º fator do CPF, LGPD e o formato de resposta
                  ficam sempre no código — só o tom/identidade é editável aqui.
                </span>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Canais de pagamento (aparecem na mensagem financeira)</span>
                <textarea value={canaisPagamento} onChange={(e) => setCanaisPagamento(e.target.value)} rows={3} className={inputCls} placeholder="Ex.: PIX da escola: chave X — ou na secretaria. (Vazio = orienta procurar a secretaria.)" />
              </label>

              <div className="flex items-center gap-3">
                <button onClick={salvar} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Salvar
                </button>
                {msg && <span className="text-sm text-slate-600">{msg}</span>}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
