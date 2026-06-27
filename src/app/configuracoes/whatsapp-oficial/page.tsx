'use client'

import { useEffect, useState } from 'react'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, CheckCircle2, XCircle } from 'lucide-react'

const CALLBACK = 'https://escola-crm.vercel.app/api/webhook/whatsapp-cloud'

export default function WhatsappOficialPage() {
  const [loading, setLoading] = useState(true)
  const [conf, setConf] = useState({ configurado: false, verifyConfigurado: false })

  useEffect(() => {
    fetch('/api/whatsapp-cloud/status').then((r) => r.json()).then((d) => { setConf(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  function Item({ ok, children }: { ok: boolean; children: React.ReactNode }) {
    return (
      <div className="flex items-center gap-2 text-sm">
        {ok ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <XCircle className="w-4 h-4 text-slate-300" />}
        <span className={ok ? 'text-slate-700' : 'text-slate-500'}>{children}</span>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-2xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">WhatsApp Oficial (Meta)</h1>
        <p className="text-sm text-slate-500 mb-6">Canal pela API oficial da Meta (Cloud API), em paralelo ao Evolution.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
          <div className="text-sm font-semibold">Status</div>
          {loading ? (
            <span className="inline-flex items-center gap-1 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Verificando...</span>
          ) : (
            <div className="space-y-1.5">
              <Item ok={conf.configurado}>Token e Phone Number ID configurados (Vercel)</Item>
              <Item ok={conf.verifyConfigurado}>Verify token configurado (Vercel)</Item>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 mt-4">
          <div className="text-sm font-semibold mb-2">Para conectar na Meta</div>
          <ol className="text-sm text-slate-600 space-y-2 list-decimal pl-5">
            <li>No app da Meta (WhatsApp → Configuração → Webhook), use esta Callback URL:</li>
          </ol>
          <div className="my-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs font-mono break-all">{CALLBACK}</div>
          <ol className="text-sm text-slate-600 space-y-2 list-decimal pl-5" start={2}>
            <li>Defina o mesmo <span className="font-mono">Verify token</span> que você colocou no Vercel (<span className="font-mono">WHATSAPP_VERIFY_TOKEN</span>) e assine o campo <span className="font-mono">messages</span>.</li>
            <li>No Vercel, configure <span className="font-mono">WHATSAPP_CLOUD_TOKEN</span>, <span className="font-mono">WHATSAPP_PHONE_NUMBER_ID</span> e <span className="font-mono">WHATSAPP_VERIFY_TOKEN</span>.</li>
          </ol>
          <p className="text-xs text-slate-400 mt-3">O Evolution continua ativo. Este canal só responde no número conectado à Meta.</p>
        </div>
      </div>
    </div>
  )
}
