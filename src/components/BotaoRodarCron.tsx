'use client'

import { useState } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'

// Botão de "rodar agora": aciona manualmente o follow-up/lembretes e o sync do Google,
// sem esperar o horário automático (útil no plano Hobby, onde o cron é 1x/dia).
export function BotaoRodarCron() {
  const [rodando, setRodando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function rodar() {
    if (rodando) return
    setRodando(true)
    setMsg(null)
    try {
      const r = await fetch('/api/admin/rodar-cron', { method: 'POST' })
      const j = await r.json()
      if (!r.ok) {
        setMsg(j?.error || 'Falha ao rodar.')
        return
      }
      const f = j.followup || {}
      const fTxt = f.skipped ? `follow-up: ${f.skipped}` : `follow-up: ${f.enviados ?? 0} enviado(s)`
      const g = j.google || {}
      const gTxt = g.erro ? 'Google: erro' : 'Google: sincronizado'
      setMsg(`Pronto — ${fTxt}; ${gTxt}.`)
    } catch {
      setMsg('Falha de conexão.')
    } finally {
      setRodando(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-blue-50 p-2 text-blue-600"><RefreshCw className="w-5 h-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Rodar agora (follow-up + Google)</div>
          <p className="text-xs text-slate-500 mt-0.5">
            Dispara na hora os follow-ups/lembretes e a sincronização com o Google Agenda, sem esperar o horário
            automático. (O follow-up só envia dentro do horário comercial.)
          </p>
          {msg && <p className="text-xs text-slate-600 mt-2">{msg}</p>}
        </div>
        <button
          onClick={rodar}
          disabled={rodando}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60"
        >
          {rodando ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {rodando ? 'Rodando...' : 'Rodar'}
        </button>
      </div>
    </div>
  )
}
