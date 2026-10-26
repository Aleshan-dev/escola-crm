'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, ShieldCheck } from 'lucide-react'
import { AbasVersao, BarraRascunho, HistoricoVersoes, TestarRascunho, useVersoesAgente } from '@/components/agentes/Versionamento'

// Comportamento do Salomão — atendente de FAMÍLIAS MATRICULADAS (irmão da Sara).
// Só o preâmbulo de persona (tom/identidade) é editável aqui; as travas de
// segurança (2º fator do CPF, LGPD) e o formato JSON ficam no código (salomao.ts).
// Modelo, credencial, preâmbulo e canais são VERSIONADOS (rascunho → publicar);
// o kill switch "Salomão ativo" não: vale na hora.

export default function SalomaoConfigPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [salvandoAtivo, setSalvandoAtivo] = useState(false)
  const [msgAtivo, setMsgAtivo] = useState<string | null>(null)
  const [aba, setAba] = useState<'config' | 'historico'>('config')

  const [ativo, setAtivo] = useState(false)
  const v = useVersoesAgente('salomao')
  const f = v.form
  const [credenciais, setCredenciais] = useState<{ id: string; provedor: string; nome: string | null; ultimos4: string | null }[]>([])

  async function load() {
    setLoading(true)
    const [{ data }, credsResp] = await Promise.all([
      supabase.from('config_ia').select('*').eq('id', 1).single(),
      fetch('/api/credenciais').then((r) => r.json()).catch(() => ({ credenciais: [] })),
    ])
    const c = data as { salomao_ativo?: boolean } | null
    if (c) setAtivo(!!c.salomao_ativo)
    setCredenciais(credsResp?.credenciais || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Kill switch: efeito imediato, fora do versionamento.
  async function alternarAtivo(novo: boolean) {
    setSalvandoAtivo(true)
    setMsgAtivo(null)
    const { error } = await supabase
      .from('config_ia')
      .update({ salomao_ativo: novo, atualizado_em: new Date().toISOString() })
      .eq('id', 1)
    setSalvandoAtivo(false)
    if (error) { setMsgAtivo(`Erro ao salvar: ${error.message}`); return }
    setAtivo(novo)
    setMsgAtivo(novo ? 'Salomão ligado.' : 'Salomão desligado.')
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
        <p className="text-sm text-slate-500 mb-4">Atendente das famílias já matriculadas (financeiro, 2ª via, recados).</p>

        <AbasVersao aba={aba} setAba={setAba} total={v.estado?.versoes.length ?? 0} />

        {aba === 'historico' ? (
          <HistoricoVersoes agente="salomao" v={v} />
        ) : loading || !v.estado ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="space-y-8">
            <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
              {/* Kill switch */}
              <div className="rounded-lg border border-slate-200 p-3">
                <label className="flex items-start gap-3 text-sm text-slate-700">
                  <input type="checkbox" checked={ativo} disabled={salvandoAtivo} onChange={(e) => alternarAtivo(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="font-medium">Salomão ativo</span>
                    <span className="block text-xs text-slate-500 mt-0.5">
                      Ligado, o Salomão atende automaticamente as famílias matriculadas no WhatsApp.
                      Desligado, o comportamento é o legado: a IA pausa e o atendimento vai para um humano.
                      Vale na hora (não passa por rascunho).
                    </span>
                    {msgAtivo && <span className="block text-xs text-emerald-700 mt-1">{msgAtivo}</span>}
                  </span>
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Modelo</span>
                <input value={(f.salomao_modelo as string) ?? ''} onChange={(e) => v.set('salomao_modelo', e.target.value)} className={inputCls} placeholder="gpt-4o (vazio = usa o modelo da Sara)" />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Credencial de IA</span>
                <select value={(f.salomao_credencial_id as string) ?? ''} onChange={(e) => v.set('salomao_credencial_id', e.target.value || null)} className={inputCls}>
                  <option value="">Padrão (chave do ambiente)</option>
                  {credenciais.map((c) => (
                    <option key={c.id} value={c.id}>{(c.nome || c.provedor) + ' · …' + (c.ultimos4 || '')}</option>
                  ))}
                </select>
                <Link href="/configuracoes/credenciais" className="text-xs text-blue-600 hover:underline mt-1 inline-block">Gerenciar credenciais</Link>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Preâmbulo de persona (tom e identidade)</span>
                <textarea value={(f.salomao_system_prompt as string) ?? ''} onChange={(e) => v.set('salomao_system_prompt', e.target.value)} rows={12} className={`${inputCls} font-mono text-xs leading-relaxed`} placeholder="Vazio = usa o texto padrão do código." />
                <span className="mt-1.5 flex items-start gap-1.5 text-[11px] text-slate-500">
                  <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
                  Por segurança, as travas de 2º fator do CPF, LGPD e o formato de resposta
                  ficam sempre no código — só o tom/identidade é editável aqui.
                </span>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Canais de pagamento (aparecem na mensagem financeira)</span>
                <textarea value={(f.salomao_canais_pagamento as string) ?? ''} onChange={(e) => v.set('salomao_canais_pagamento', e.target.value)} rows={3} className={inputCls} placeholder="Ex.: PIX da escola: chave X — ou na secretaria. (Vazio = orienta procurar a secretaria.)" />
              </label>

              <BarraRascunho agente="salomao" v={v} />
            </section>

            <TestarRascunho agente="salomao" v={v} />
          </div>
        )}
      </div>
    </div>
  )
}
