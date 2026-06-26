'use client'

import { useEffect, useState } from 'react'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Calendar, CheckCircle2 } from 'lucide-react'

export default function IntegracoesPage() {
  const [loading, setLoading] = useState(true)
  const [conectado, setConectado] = useState(false)

  useEffect(() => {
    fetch('/api/google/status')
      .then((r) => r.json())
      .then((d) => { setConectado(!!d.conectado); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Integrações</h1>
        <p className="text-sm text-slate-500 mb-6">Conecte serviços externos à escola.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-blue-50 p-2 text-blue-600"><Calendar className="w-5 h-5" /></div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">Google Agenda</div>
              <p className="text-xs text-slate-500 mt-0.5">Sincroniza as visitas e tarefas com o Google Calendar.</p>
            </div>
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            ) : conectado ? (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-green-600"><CheckCircle2 className="w-4 h-4" /> Conectado</span>
            ) : (
              <a href="/api/google/connect" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">Conectar</a>
            )}
          </div>
          {conectado && (
            <a href="/api/google/connect" className="mt-3 inline-block text-xs text-slate-400 hover:text-slate-600">Reconectar conta</a>
          )}
        </div>
      </div>
    </div>
  )
}
