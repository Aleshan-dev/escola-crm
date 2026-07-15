'use client'

import { useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'

// Submete o template de follow-up "retomada_lead" à Meta (uma vez). A aprovação
// é acompanhada no WhatsApp Manager.
export function BotaoCriarTemplate() {
  const [rodando, setRodando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function criar() {
    if (rodando) return
    setRodando(true)
    setMsg(null)
    try {
      const r = await fetch('/api/admin/criar-template', { method: 'POST' })
      const j = await r.json()
      if (!r.ok) {
        setMsg(`Falha: ${j?.error || 'erro'}`)
        return
      }
      setMsg('Template enviado para aprovação da Meta ✓ — acompanhe no WhatsApp Manager.')
    } catch {
      setMsg('Falha de conexão.')
    } finally {
      setRodando(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-blue-50 p-2 text-blue-600"><FileText className="w-5 h-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Criar template de follow-up (fora das 24h)</div>
          <p className="text-xs text-slate-500 mt-0.5">
            Submete o modelo &quot;retomada_lead&quot; para aprovação da Meta. Só precisa clicar uma vez.
          </p>
          {msg && <p className="text-xs text-slate-600 mt-2">{msg}</p>}
        </div>
        <button
          onClick={criar}
          disabled={rodando}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60"
        >
          {rodando ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
          {rodando ? 'Enviando...' : 'Criar'}
        </button>
      </div>
    </div>
  )
}
