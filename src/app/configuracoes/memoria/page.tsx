'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Save } from 'lucide-react'

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

export default function MemoriaConfigPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [ativa, setAtiva] = useState(true)
  const [orcamento, setOrcamento] = useState(2500)

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('config_ia')
        .select('memoria_ativa, memoria_orcamento_chars')
        .eq('id', 1)
        .single()
      if (data) {
        setAtiva(data.memoria_ativa !== false)
        setOrcamento(data.memoria_orcamento_chars ?? 2500)
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function salvar() {
    setSaving(true)
    setMsg(null)
    const { error } = await supabase
      .from('config_ia')
      .update({
        memoria_ativa: ativa,
        memoria_orcamento_chars: Math.min(8000, Math.max(500, Math.round(orcamento) || 2500)),
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', 1)
    setSaving(false)
    setMsg(error ? `Erro ao salvar: ${error.message}` : 'Configurações salvas.')
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-2xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Memória do lead</h1>
        <p className="text-sm text-slate-500 mb-6">
          Fatos duráveis de cada família (preferências, restrições, contexto, combinados) que a Sara e o Salomão lembram
          entre conversas, além das últimas 20 mensagens. Gravados pela própria IA durante a conversa e, para conversas
          longas, por uma leitura automática do histórico antigo. A equipe corrige e arquiva na ficha do lead.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-1" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} />
              <span><b>Ligar memória</b><br /><span className="text-xs text-slate-500">Desligada, a IA não lê nem grava memória e a leitura do histórico para. As notas existentes continuam guardadas.</span></span>
            </label>

            <label className="block border-t border-slate-100 pt-4">
              <span className="mb-1 block text-xs font-medium text-slate-500">Tamanho máximo da memória por lead (caracteres)</span>
              <input type="number" min={500} max={8000} step={100} value={orcamento} onChange={(e) => setOrcamento(Number(e.target.value))} className={inputCls} />
              <span className="mt-1 block text-xs text-slate-400">Entre 500 e 8000. Cheia, a IA precisa juntar notas antigas para gravar novas. 2500 ≈ 10 a 15 fatos.</span>
            </label>

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
              <button onClick={salvar} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar
              </button>
              {msg && <span className="text-sm text-slate-600">{msg}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
