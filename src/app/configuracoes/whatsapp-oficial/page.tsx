/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { ArrowLeft, Loader2, MessageSquareText } from 'lucide-react'

const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || '2451104688636688'
const CONFIG_ID = process.env.NEXT_PUBLIC_META_CONFIG_ID || '1479514487198126'
// Vazio = fluxo padrão. Para coexistência, use a Configuration de "Business App users"
// e defina NEXT_PUBLIC_META_FEATURE_TYPE conforme a spec atual da Meta.
const FEATURE_TYPE = process.env.NEXT_PUBLIC_META_FEATURE_TYPE || ''

type Conta = {
  id: string
  numero_exibicao: string | null
  nome_verificado: string | null
  phone_number_id: string
  verificado: boolean
  ativo: boolean
}

export default function WhatsappOficialPage() {
  const supabase = createClient()
  const [contas, setContas] = useState<Conta[]>([])
  const [carregando, setCarregando] = useState(true)
  const [conectando, setConectando] = useState(false)
  const [msg, setMsg] = useState('')
  const [status, setStatus] = useState<any>(null)

  const carregar = useCallback(async () => {
    const { data } = await supabase
      .from('whatsapp_contas')
      .select('id, numero_exibicao, nome_verificado, phone_number_id, verificado, ativo')
      .order('criado_em', { ascending: false })
    setContas((data as unknown as Conta[]) || [])
    setCarregando(false)
  }, [supabase])

  useEffect(() => { carregar() }, [carregar])

  useEffect(() => {
    fetch('/api/whatsapp-cloud/status').then((r) => r.json()).then(setStatus).catch(() => {})
  }, [])

  // Carrega o SDK do Facebook
  useEffect(() => {
    if (document.getElementById('fb-sdk')) return
    ;(window as any).fbAsyncInit = function () {
      ;(window as any).FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: 'v21.0' })
    }
    const s = document.createElement('script')
    s.id = 'fb-sdk'; s.async = true; s.defer = true; s.crossOrigin = 'anonymous'
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    document.body.appendChild(s)
  }, [])

  // Captura phone_number_id / waba_id que o Embedded Signup envia via postMessage
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (typeof ev.origin !== 'string' || !ev.origin.endsWith('facebook.com')) return
      try {
        const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
        if (d?.type === 'WA_EMBEDDED_SIGNUP') (window as any).__wa_signup = d.data || {}
      } catch { /* ignore */ }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  function conectar() {
    const FB = (window as any).FB
    if (!FB) { setMsg('SDK do Facebook ainda carregando — tente de novo em alguns segundos.'); return }
    setMsg(''); setConectando(true)
    FB.login(
      (resp: any) => {
        const code = resp?.authResponse?.code
        if (!code) { setConectando(false); setMsg('Conexão cancelada.'); return }
        const info = (window as any).__wa_signup || {}
        fetch('/api/whatsapp-cloud/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, phone_number_id: info.phone_number_id, waba_id: info.waba_id }),
        })
          .then((r) => r.json())
          .then((j) => {
            setConectando(false)
            if (j?.ok) { setMsg('Número conectado com sucesso! 🎉'); carregar() }
            else setMsg('Falha ao conectar: ' + (j?.erro || 'erro desconhecido') + (j?.detalhe ? ` — ${typeof j.detalhe === 'string' ? j.detalhe : JSON.stringify(j.detalhe)}` : ''))
          })
          .catch(() => { setConectando(false); setMsg('Falha ao salvar a conexão.') })
      },
      {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: FEATURE_TYPE, sessionInfoVersion: '3' },
      }
    )
  }

  async function desativar(id: string) {
    await supabase.from('whatsapp_contas').update({ ativo: false }).eq('id', id)
    carregar()
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#EEF2FF]">
      <Topbar />
      <div className="mx-auto w-full max-w-3xl p-6">
        <Link href="/configuracoes" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Configurações
        </Link>

        <div className="mb-1 flex items-center gap-2">
          <MessageSquareText className="h-5 w-5 text-[#1A237E]" />
          <h1 className="text-xl font-bold text-slate-900">WhatsApp Oficial (Meta)</h1>
        </div>
        <p className="mb-5 text-sm text-slate-500">
          Conecte um número pela API oficial da Meta (Cloud API). Funciona mesmo com o celular desligado.
        </p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          {status && (
            <div className="mb-4 rounded-lg border border-slate-100 bg-slate-50 p-4 text-sm">
              <div className="mb-2 font-semibold text-slate-700">Diagnóstico da conexão</div>
              <DiagRow ok={status.metaAppSecret} label="App Secret da Meta (META_APP_SECRET)" hint="Necessário para conectar — configure na Vercel." />
              <DiagRow ok={status.verifyToken} label="Token de verificação do webhook (WHATSAPP_VERIFY_TOKEN)" hint="Necessário para o webhook validar na Meta." />
              <div className="mt-3">
                <div className="text-xs font-medium text-slate-500">URL do webhook (cadastre no app da Meta, assinando o campo &ldquo;messages&rdquo;):</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 break-all rounded border border-slate-200 bg-white px-2 py-1 text-xs">{status.webhookUrl}</code>
                  <button onClick={() => navigator.clipboard?.writeText(status.webhookUrl)} className="text-xs font-medium text-blue-600 hover:underline">Copiar</button>
                </div>
              </div>
            </div>
          )}
          <button
            onClick={conectar}
            disabled={conectando}
            className="rounded-lg bg-[#1A237E] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#283593] disabled:opacity-60"
          >
            {conectando ? 'Conectando...' : 'Conectar WhatsApp'}
          </button>
          {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}

          <div className="mt-5">
            <div className="mb-2 text-sm font-semibold text-slate-700">Números conectados</div>
            {carregando ? (
              <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Carregando...</div>
            ) : contas.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhum número conectado ainda.</p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {contas.map((c) => (
                  <div key={c.id} className="flex items-center justify-between p-3 text-sm">
                    <div>
                      <div className="font-medium text-slate-800">{c.numero_exibicao || c.phone_number_id}</div>
                      <div className="text-xs text-slate-500">
                        {(c.nome_verificado || '—')} · {c.ativo ? 'ativo' : 'inativo'}
                      </div>
                    </div>
                    {c.ativo && (
                      <button onClick={() => desativar(c.id)} className="text-xs font-medium text-red-600 hover:underline">
                        Desativar
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function DiagRow({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className={`mt-0.5 text-xs ${ok ? 'text-green-600' : 'text-red-600'}`}>{ok ? '✓' : '✕'}</span>
      <div>
        <div className="text-slate-700">{label}</div>
        {!ok && <div className="text-xs text-red-600">{hint}</div>}
      </div>
    </div>
  )
}
