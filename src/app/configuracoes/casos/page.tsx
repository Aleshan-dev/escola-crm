'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, Save, Send } from 'lucide-react'

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

type Guarda = 'off' | 'log' | 'ativo'

export default function CasosConfigPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testando, setTestando] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [ativo, setAtivo] = useState(false)
  const [telefone, setTelefone] = useState('')
  const [telTransbordo, setTelTransbordo] = useState('')
  const [comandos, setComandos] = useState(false)
  const [guarda, setGuarda] = useState<Guarda>('log')

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('config_ia')
        .select('casos_ativo, casos_telefone_aviso, casos_comandos_whatsapp, casos_guarda_promessa, telefone_transbordo')
        .eq('id', 1)
        .single()
      if (data) {
        setAtivo(data.casos_ativo === true)
        setTelefone(data.casos_telefone_aviso || '')
        setTelTransbordo(data.telefone_transbordo || '')
        setComandos(data.casos_comandos_whatsapp === true)
        setGuarda((data.casos_guarda_promessa as Guarda) || 'log')
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
        casos_ativo: ativo,
        casos_telefone_aviso: telefone.replace(/\D/g, '') || null,
        casos_comandos_whatsapp: comandos,
        casos_guarda_promessa: guarda,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', 1)
    setSaving(false)
    setMsg(error ? `Erro ao salvar: ${error.message}` : 'Configurações salvas.')
  }

  async function testar() {
    if (!confirm('Enviar um aviso de TESTE de verdade para o número configurado? (salve antes se mudou o número)')) return
    setTestando(true)
    setMsg(null)
    const r = await fetch('/api/casos/aviso-teste', { method: 'POST' })
    const j = await r.json().catch(() => ({}))
    setTestando(false)
    setMsg(r.ok ? 'Aviso de teste enviado.' : `Falhou: ${j.error || r.status}`)
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-2xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">Casos</h1>
        <p className="text-sm text-slate-500 mb-6">
          Quando a Sara ou o Salomão não sabem resolver, abrem um Caso para a equipe e seguem falando com a família.
          A equipe conclui, pede informação ou passa para humano na tela <Link href="/casos" className="text-blue-600 hover:underline">Casos</Link>.
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-1" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
              <span><b>Ligar Casos</b><br /><span className="text-xs text-slate-500">Desligado, a Sara e o Salomão seguem como antes (prometem verificar ou fazem transbordo).</span></span>
            </label>

            <label className="block border-t border-slate-100 pt-4">
              <span className="mb-1 block text-xs font-medium text-slate-500">WhatsApp que recebe os avisos de Caso</span>
              <input value={telefone} onChange={(e) => setTelefone(e.target.value)} className={inputCls} placeholder={telTransbordo ? `Vazio = usa o do gestor (${telTransbordo})` : '5568999998888'} />
              <span className="mt-1 block text-xs text-slate-400">Somente dígitos, com o 55. Recebe o aviso na abertura, quando a família responde, e uma cobrança a cada 24h parado (até 3).</span>
            </label>

            <label className="flex items-start gap-2 text-sm text-slate-700">
              <input type="checkbox" className="mt-1" checked={comandos} onChange={(e) => setComandos(e.target.checked)} />
              <span>Responder Casos pelo WhatsApp<br /><span className="text-xs text-slate-500">Desse número, mensagens como <code>#C12 ok tem vaga</code>, <code>#C12 pedir qual o turno?</code> ou <code>#C12 humano</code> decidem o Caso.</span></span>
            </label>

            <label className="block border-t border-slate-100 pt-4">
              <span className="mb-1 block text-xs font-medium text-slate-500">Guarda de promessa</span>
              <select value={guarda} onChange={(e) => setGuarda(e.target.value as Guarda)} className={inputCls}>
                <option value="off">Desligada</option>
                <option value="log">Só registrar (recomendado no início)</option>
                <option value="ativo">Ativa: refaz a resposta e, se insistir, abre Caso</option>
              </select>
              <span className="mt-1 block text-xs text-slate-400">Pega a IA prometendo &quot;vou verificar&quot; / &quot;te retorno&quot; sem abrir Caso. Detecta frases conhecidas, não toda paráfrase.</span>
            </label>

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
              <button onClick={salvar} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar
              </button>
              <button onClick={testar} disabled={testando} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60">
                {testando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Enviar aviso de teste
              </button>
              {msg && <span className="text-sm text-slate-600">{msg}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
