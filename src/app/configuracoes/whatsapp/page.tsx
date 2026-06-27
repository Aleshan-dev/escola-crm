'use client'

import { useEffect, useRef, useState } from 'react'
import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import { ArrowLeft, Loader2, RefreshCw, CheckCircle2 } from 'lucide-react'

function rotuloEstado(s: string) {
  if (s === 'open') return { txt: 'Conectado', cor: 'text-green-600' }
  if (s === 'connecting') return { txt: 'Conectando...', cor: 'text-amber-600' }
  if (s === 'close') return { txt: 'Desconectado', cor: 'text-red-600' }
  if (s === 'unconfigured') return { txt: 'Não configurado', cor: 'text-slate-500' }
  return { txt: s || '—', cor: 'text-slate-500' }
}

export default function WhatsappPage() {
  const [estado, setEstado] = useState('')
  const [loading, setLoading] = useState(true)
  const [qr, setQr] = useState<string | null>(null)
  const [pairing, setPairing] = useState<string | null>(null)
  const [conectando, setConectando] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function checar() {
    const r = await fetch('/api/evolution/status').then((x) => x.json()).catch(() => ({ state: 'erro' }))
    setEstado(r.state || 'erro')
    setLoading(false)
    if (r.state === 'open') {
      setQr(null); setPairing(null); setConectando(false)
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
  }

  useEffect(() => {
    checar()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function conectar() {
    setConectando(true)
    setQr(null); setPairing(null)
    const r = await fetch('/api/evolution/connect').then((x) => x.json()).catch(() => ({}))
    let b: string | null = r.base64 || null
    if (b && !b.startsWith('data:')) b = `data:image/png;base64,${b}`
    setQr(b)
    setPairing(r.pairingCode || null)
    setConectando(false)
    if (!pollRef.current) pollRef.current = setInterval(checar, 3000)
  }

  const e = rotuloEstado(estado)

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-2xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"><ArrowLeft className="w-4 h-4" /> Configurações</Link>
        <h1 className="text-xl font-semibold mb-1">WhatsApp (Evolution)</h1>
        <p className="text-sm text-slate-500 mb-6">Status da conexão do número da escola com o WhatsApp.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium mb-0.5">Status da conexão</div>
              {loading ? (
                <span className="inline-flex items-center gap-1 text-sm text-slate-500"><Loader2 className="w-4 h-4 animate-spin" /> Verificando...</span>
              ) : (
                <span className={`inline-flex items-center gap-1 text-sm font-semibold ${e.cor}`}>
                  {estado === 'open' && <CheckCircle2 className="w-4 h-4" />} {e.txt}
                </span>
              )}
            </div>
            <button onClick={() => { setLoading(true); checar() }} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"><RefreshCw className="w-4 h-4" /> Atualizar</button>
          </div>

          {!loading && estado !== 'open' && estado !== 'unconfigured' && (
            <div className="mt-5 border-t border-slate-100 pt-5">
              {!qr ? (
                <button onClick={conectar} disabled={conectando} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                  {conectando ? 'Gerando QR...' : 'Conectar WhatsApp'}
                </button>
              ) : (
                <div className="text-center">
                  <p className="text-sm text-slate-600 mb-3">No celular: WhatsApp → Aparelhos conectados → Conectar aparelho, e escaneie:</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="QR Code do WhatsApp" className="mx-auto w-56 h-56 rounded-lg border border-slate-200" />
                  {pairing && <p className="text-sm text-slate-500 mt-3">Ou use o código: <span className="font-mono font-semibold">{pairing}</span></p>}
                  <p className="text-xs text-slate-400 mt-3 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Aguardando leitura...</p>
                </div>
              )}
            </div>
          )}

          {estado === 'unconfigured' && (
            <p className="mt-4 text-sm text-slate-500">As variáveis da Evolution não estão configuradas no servidor.</p>
          )}
        </div>
      </div>
    </div>
  )
}
