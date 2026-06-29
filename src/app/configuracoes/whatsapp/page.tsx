/* eslint-disable @next/next/no-img-element */
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Topbar } from '@/components/Topbar'
import { ArrowLeft, Loader2, RefreshCw, CheckCircle2, XCircle, Power } from 'lucide-react'

export default function WhatsappEvolutionPage() {
  const [state, setState] = useState('')
  const [carregando, setCarregando] = useState(true)
  const [qr, setQr] = useState<string | null>(null)
  const [pairing, setPairing] = useState<string | null>(null)
  const [acao, setAcao] = useState('')

  const status = useCallback(async () => {
    setCarregando(true)
    try {
      const r = await fetch('/api/evolution/status', { cache: 'no-store' })
      const j = await r.json()
      setState(j?.state || 'desconhecido')
    } catch { setState('erro') }
    setCarregando(false)
  }, [])

  useEffect(() => { status() }, [status])

  const conectado = state === 'open'
  const qrSrc = qr ? (qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`) : null

  async function gerarQr() {
    setAcao('Gerando QR...'); setQr(null); setPairing(null)
    try {
      const r = await fetch('/api/evolution/connect', { cache: 'no-store' })
      const j = await r.json()
      setQr(j?.base64 || null); setPairing(j?.pairingCode || null)
      setAcao(j?.base64 || j?.pairingCode ? '' : 'Não veio QR — a instância ainda se considera conectada. Use "Desconectar e gerar novo QR".')
    } catch { setAcao('Falha ao gerar QR.') }
  }

  async function desconectar() {
    setAcao('Desconectando...'); setQr(null); setPairing(null)
    try {
      await fetch('/api/evolution/logout', { cache: 'no-store' })
      await new Promise((r) => setTimeout(r, 1500))
      await status()
      await gerarQr()
    } catch { setAcao('Falha ao desconectar.') }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#EEF2FF]">
      <Topbar />
      <div className="mx-auto w-full max-w-3xl p-6">
        <Link href="/configuracoes" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Configurações
        </Link>
        <h1 className="text-xl font-bold text-slate-900">WhatsApp (Evolution)</h1>
        <p className="mb-5 text-sm text-slate-500">Status e conexão do número da escola com o WhatsApp.</p>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-700">Status da conexão</div>
              {carregando ? (
                <div className="mt-1 flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Verificando...</div>
              ) : conectado ? (
                <div className="mt-1 flex items-center gap-2 text-sm font-medium text-green-600"><CheckCircle2 className="h-4 w-4" /> Conectado</div>
              ) : (
                <div className="mt-1 flex items-center gap-2 text-sm font-medium text-red-600"><XCircle className="h-4 w-4" /> Desconectado ({state})</div>
              )}
            </div>
            <button onClick={status} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" /> Atualizar
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {!conectado && (
              <button onClick={gerarQr} className="rounded-lg bg-[#1A237E] px-4 py-2 text-sm font-medium text-white hover:bg-[#283593]">Gerar QR / Conectar</button>
            )}
            <button onClick={desconectar} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50">
              <Power className="h-4 w-4" /> Desconectar e gerar novo QR
            </button>
          </div>

          {acao && <p className="mt-3 text-sm text-slate-600">{acao}</p>}

          {qrSrc && (
            <div className="mt-4">
              <p className="mb-2 text-sm text-slate-600">Escaneie com o WhatsApp da escola (Aparelhos conectados → Conectar um aparelho) e <b>mantenha o celular ligado e com internet por alguns minutos</b>:</p>
              <img src={qrSrc} alt="QR Code" className="h-64 w-64 rounded-lg border border-slate-200" />
            </div>
          )}
          {pairing && <p className="mt-2 text-sm text-slate-600">Código de pareamento: <b>{pairing}</b></p>}
        </div>

        <p className="mt-4 text-xs text-slate-400">Se o status ficar "Conectado" mas as mensagens não chegarem, é sessão travada: clique em "Desconectar e gerar novo QR" e re-pareie com o celular online.</p>
      </div>
    </div>
  )
}
