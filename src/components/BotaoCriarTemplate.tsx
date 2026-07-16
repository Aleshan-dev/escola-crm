'use client'

import { useEffect, useState } from 'react'
import { FileText, Loader2, RefreshCw } from 'lucide-react'

type Template = { name: string; status: string; category?: string; language?: string }

function statusPt(s: string) {
  const u = (s || '').toUpperCase()
  if (u === 'APPROVED') return { txt: 'Aprovado', cls: 'bg-green-100 text-green-700' }
  if (u === 'PENDING' || u === 'IN_APPEAL' || u === 'PENDING_DELETION') return { txt: 'Em análise', cls: 'bg-amber-100 text-amber-700' }
  if (u === 'REJECTED') return { txt: 'Rejeitado', cls: 'bg-red-100 text-red-700' }
  return { txt: s || '—', cls: 'bg-slate-100 text-slate-600' }
}

export function BotaoCriarTemplate() {
  const [rodando, setRodando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [carregando, setCarregando] = useState(false)

  async function carregarStatus() {
    setCarregando(true)
    try {
      const r = await fetch('/api/admin/listar-templates')
      const j = await r.json()
      if (r.ok) setTemplates(j.templates || [])
      else setTemplates([])
    } catch {
      setTemplates([])
    } finally {
      setCarregando(false)
    }
  }

  useEffect(() => { carregarStatus() }, [])

  async function criar() {
    if (rodando) return
    setRodando(true)
    setMsg(null)
    try {
      const r = await fetch('/api/admin/criar-template', { method: 'POST' })
      const j = await r.json()
      if (!r.ok) { setMsg(`Falha: ${j?.error || 'erro'}`); return }
      setMsg('Template enviado para aprovação da Meta ✓')
      await carregarStatus()
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
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Templates de WhatsApp (follow-up fora das 24h)</div>
            <button onClick={carregarStatus} disabled={carregando} className="text-slate-400 hover:text-slate-600" title="Atualizar status">
              <RefreshCw className={`w-3.5 h-3.5 ${carregando ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Lista de templates + status */}
          <div className="mt-2 space-y-1">
            {carregando && templates === null ? (
              <p className="text-xs text-slate-400">Carregando status...</p>
            ) : templates && templates.length > 0 ? (
              templates.map((t) => {
                const s = statusPt(t.status)
                return (
                  <div key={t.name} className="flex items-center justify-between text-xs">
                    <span className="text-slate-700">{t.name}</span>
                    <span className={`rounded-full px-2 py-0.5 font-medium ${s.cls}`}>{s.txt}</span>
                  </div>
                )
              })
            ) : (
              <p className="text-xs text-slate-400">Nenhum template ainda. Clique em &quot;Criar&quot; para submeter o &quot;retomada_lead&quot;.</p>
            )}
          </div>

          {msg && <p className="mt-2 text-xs text-slate-600">{msg}</p>}
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
