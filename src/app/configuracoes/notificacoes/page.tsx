'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Save } from 'lucide-react'

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

export default function NotificacoesGestorPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [telefone, setTelefone] = useState('')
  const [notifVisita, setNotifVisita] = useState(true)
  const [notifEncerr, setNotifEncerr] = useState(true)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('config_ia')
      .select('telefone_transbordo, notif_visita_agendada, notif_encerramento')
      .eq('id', 1)
      .single()
    const c = data as { telefone_transbordo?: string; notif_visita_agendada?: boolean; notif_encerramento?: boolean } | null
    if (c) {
      setTelefone(c.telefone_transbordo || '')
      setNotifVisita(c.notif_visita_agendada !== false)
      setNotifEncerr(c.notif_encerramento !== false)
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
    const tel = telefone.replace(/\D/g, '')
    const { error } = await supabase
      .from('config_ia')
      .update({
        telefone_transbordo: tel || null,
        notif_visita_agendada: notifVisita,
        notif_encerramento: notifEncerr,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', 1)
    setSaving(false)
    setMsg(error ? `Erro ao salvar: ${error.message}` : 'Configurações salvas com sucesso.')
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-2xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Notificações do gestor</h1>
        <p className="text-sm text-slate-500 mb-6">Número do gestor que recebe os avisos por WhatsApp e quais eventos notificam.</p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500">WhatsApp do gestor</span>
              <input value={telefone} onChange={(e) => setTelefone(e.target.value)} className={inputCls} placeholder="5568999998888 (código do país + DDD + número)" />
              <span className="mt-1 block text-xs text-slate-400">Somente dígitos, com o 55 na frente. Ex.: 5568999998888.</span>
            </label>

            <div className="border-t border-slate-100 pt-4">
              <div className="mb-2 text-sm font-medium text-slate-700">Quero ser avisado quando:</div>
              <label className="flex items-center gap-2 py-1.5 text-sm text-slate-700">
                <input type="checkbox" checked={notifVisita} onChange={(e) => setNotifVisita(e.target.checked)} />
                A Sara agendar uma visita
              </label>
              <label className="flex items-center gap-2 py-1.5 text-sm text-slate-700">
                <input type="checkbox" checked={notifEncerr} onChange={(e) => setNotifEncerr(e.target.checked)} />
                Um atendimento for encerrado (lead vira Matrícula ou Perdido)
              </label>
              <p className="mt-2 text-xs text-slate-400">Transbordo (atendimento humano) e falhas do sistema são sempre enviados para este número.</p>
            </div>

            <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
              <button onClick={salvar} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar
              </button>
              {msg && <span className="text-sm text-slate-600">{msg}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
