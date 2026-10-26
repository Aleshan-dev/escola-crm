/* eslint-disable @next/next/no-img-element */
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Topbar } from '@/components/Topbar'
import { ArrowLeft, Loader2, RefreshCw, CheckCircle2, XCircle, Power, AlertTriangle } from 'lucide-react'

type StatusResp = {
  state?: string
  wahaStatus?: string
  provider?: string
  session?: string
  configurado?: boolean
  erro?: string
}

export default function WahaPage() {
  const [info, setInfo] = useState<StatusResp>({})
  const [carregando, setCarregando] = useState(true)
  const [qr, setQr] = useState<string | null>(null)
  const [acao, setAcao] = useState('')

  // Credenciais (crm.integracao_waha). A chave nunca volta do servidor: `temKey`
  // diz se há uma salva; o campo fica em branco (placeholder) e só sobrescreve
  // se você digitar algo novo.
  const [apiUrl, setApiUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [sessao, setSessao] = useState('default')
  const [temKey, setTemKey] = useState(false)
  const [salvando, setSalvando] = useState(false)
  const [msgCfg, setMsgCfg] = useState('')

  // Webhook de recebimento: onde o WAHA deve postar as mensagens que chegam.
  const [whAlvo, setWhAlvo] = useState('')
  const [whRegistrado, setWhRegistrado] = useState<boolean | null>(null)
  const [whSalvando, setWhSalvando] = useState(false)
  const [whMsg, setWhMsg] = useState('')

  const status = useCallback(async () => {
    setCarregando(true)
    try {
      const r = await fetch('/api/waha/status', { cache: 'no-store' })
      const j: StatusResp = await r.json()
      setInfo(j)
    } catch {
      setInfo({ state: 'erro' })
    }
    setCarregando(false)
  }, [])

  // Carga inicial: setState só APÓS o await (não síncrono no corpo do efeito).
  useEffect(() => {
    let ativo = true
    ;(async () => {
      try {
        const r = await fetch('/api/waha/status', { cache: 'no-store' })
        const j: StatusResp = await r.json()
        if (ativo) setInfo(j)
      } catch {
        if (ativo) setInfo({ state: 'erro' })
      } finally {
        if (ativo) setCarregando(false)
      }
    })()
    return () => { ativo = false }
  }, [])

  // Carga das credenciais salvas (URL/sessão + se há chave). setState só após o await.
  useEffect(() => {
    let ativo = true
    ;(async () => {
      try {
        const r = await fetch('/api/waha/config', { cache: 'no-store' })
        const j = await r.json()
        if (!ativo) return
        setApiUrl(j?.api_url || '')
        setSessao(j?.session || 'default')
        setTemKey(!!j?.tem_key)
      } catch { /* mantém defaults */ }
    })()
    return () => { ativo = false }
  }, [])

  // Estado do webhook de recebimento. setState só após o await.
  const carregarWebhook = useCallback(async () => {
    try {
      const r = await fetch('/api/waha/webhook-register', { cache: 'no-store' })
      const j = await r.json()
      setWhAlvo(j?.alvo || '')
      setWhRegistrado(typeof j?.registrado === 'boolean' ? j.registrado : null)
    } catch { setWhRegistrado(null) }
  }, [])

  useEffect(() => {
    let ativo = true
    ;(async () => {
      try {
        const r = await fetch('/api/waha/webhook-register', { cache: 'no-store' })
        const j = await r.json()
        if (!ativo) return
        setWhAlvo(j?.alvo || '')
        setWhRegistrado(typeof j?.registrado === 'boolean' ? j.registrado : null)
      } catch { if (ativo) setWhRegistrado(null) }
    })()
    return () => { ativo = false }
  }, [])

  async function registrarWebhook() {
    setWhSalvando(true); setWhMsg('')
    try {
      const r = await fetch('/api/waha/webhook-register', { method: 'POST' })
      const j = await r.json()
      if (r.ok) { setWhMsg('Webhook registrado. As mensagens recebidas passam a chegar no chat.'); await carregarWebhook() }
      else setWhMsg(`Erro: ${j?.erro || r.status}`)
    } catch { setWhMsg('Falha de rede.') }
    setWhSalvando(false)
  }

  async function salvarConfig() {
    setSalvando(true); setMsgCfg('')
    try {
      const r = await fetch('/api/waha/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_url: apiUrl, api_key: apiKey, session: sessao }),
      })
      const j = await r.json()
      if (r.ok) {
        if (apiKey) setTemKey(true)
        setApiKey('')
        setMsgCfg('Credenciais salvas.')
        await status()
      } else {
        setMsgCfg(`Erro ao salvar: ${j?.erro || r.status}`)
      }
    } catch { setMsgCfg('Falha de rede ao salvar.') }
    setSalvando(false)
  }

  const state = info.state || 'desconhecido'
  const conectado = state === 'open'
  const naoConfigurado = state === 'unconfigured'
  const flagAtiva = (info.provider || 'evolution') === 'waha'

  async function gerarQr() {
    setAcao('Iniciando sessão e gerando QR...'); setQr(null)
    try {
      const r = await fetch('/api/waha/connect', { cache: 'no-store' })
      const j = await r.json()
      if (j?.jaConectado) {
        setAcao('A sessão já está conectada (WORKING). Para re-parear, use "Desconectar e gerar novo QR".')
        await status()
        return
      }
      setQr(j?.base64 || null)
      setAcao(
        j?.base64
          ? ''
          : j?.erro
            ? `Não veio QR: ${j.erro}`
            : `Sessão em "${j?.status || '—'}". Aguarde alguns segundos e tente "Atualizar" / "Gerar QR" de novo.`
      )
    } catch { setAcao('Falha ao gerar QR.') }
  }

  async function desconectar() {
    setAcao('Desconectando...'); setQr(null)
    try {
      await fetch('/api/waha/logout', { cache: 'no-store' })
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
        <h1 className="text-xl font-bold text-slate-900">WhatsApp Disparos (WAHA)</h1>
        <p className="mb-5 text-sm text-slate-500">
          Canal não-oficial de <b>disparos</b> (cobrança do Salomão e convites). Substitui o Evolution quando <code className="rounded bg-slate-100 px-1">WHATSAPP_PROVIDER=waha</code>.
        </p>

        {/* Aviso de topologia — a regra que não pode ser furada */}
        <div className="mb-5 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            Conecte esta sessão a um <b>chip SEPARADO</b> do número de atendimento (Cloud API). Uma sessão não-oficial no
            mesmo número da Cloud <b>desregistra o número</b> (erro 133010) e derruba o atendimento.
          </div>
        </div>

        {/* Credenciais */}
        <div className="mb-5 rounded-xl border border-slate-200 bg-white p-5">
          <div className="text-sm font-semibold text-slate-700">Credenciais da API</div>
          <p className="mt-0.5 text-xs text-slate-500">Guardadas no banco (com segurança). Se ficarem em branco, o sistema usa as variáveis de ambiente da Vercel.</p>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">URL da API do WAHA</span>
              <input
                type="url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://waha.seudominio.com"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-600">
                Chave da API (X-Api-Key){temKey && <span className="ml-1 text-green-600">• já salva</span>}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={temKey ? '•••••••• (deixe em branco para manter)' : 'cole a chave aqui'}
                autoComplete="new-password"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-slate-600">Nome da sessão</span>
              <input
                type="text"
                value={sessao}
                onChange={(e) => setSessao(e.target.value)}
                placeholder="default"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={salvarConfig}
              disabled={salvando}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#1A237E] px-4 py-2 text-sm font-medium text-white hover:bg-[#283593] disabled:opacity-60"
            >
              {salvando && <Loader2 className="h-4 w-4 animate-spin" />} Salvar credenciais
            </button>
            {msgCfg && <span className="text-sm text-slate-600">{msgCfg}</span>}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-700">Status da conexão</div>
              {carregando ? (
                <div className="mt-1 flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Verificando...</div>
              ) : naoConfigurado ? (
                <div className="mt-1 flex items-center gap-2 text-sm font-medium text-slate-500"><XCircle className="h-4 w-4" /> Não configurado — faltam WAHA_API_URL / WAHA_API_KEY</div>
              ) : conectado ? (
                <div className="mt-1 flex items-center gap-2 text-sm font-medium text-green-600"><CheckCircle2 className="h-4 w-4" /> Conectado{info.wahaStatus ? ` (${info.wahaStatus})` : ''}</div>
              ) : (
                <div className="mt-1 flex items-center gap-2 text-sm font-medium text-red-600"><XCircle className="h-4 w-4" /> Desconectado ({info.wahaStatus || state})</div>
              )}
              <div className="mt-1 text-xs text-slate-400">Sessão: <b>{info.session || '—'}</b></div>
            </div>
            <button onClick={status} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" /> Atualizar
            </button>
          </div>

          {/* Estado da flag: sessão de pé mas disparos ainda pelo Evolution */}
          {!naoConfigurado && (
            <div className={`mt-4 rounded-lg px-3 py-2 text-xs ${flagAtiva ? 'bg-green-50 text-green-700' : 'bg-slate-50 text-slate-500'}`}>
              {flagAtiva
                ? 'WHATSAPP_PROVIDER=waha — os disparos (Salomão/convites) saem por esta sessão.'
                : 'WHATSAPP_PROVIDER ainda em "evolution" — os disparos NÃO usam o WAHA. Ligue a flag na Vercel quando a sessão estiver conectada e validada.'}
            </div>
          )}

          {!naoConfigurado && (
            <div className="mt-4 flex flex-wrap gap-2">
              {!conectado && (
                <button onClick={gerarQr} className="rounded-lg bg-[#1A237E] px-4 py-2 text-sm font-medium text-white hover:bg-[#283593]">Gerar QR / Conectar</button>
              )}
              <button onClick={desconectar} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50">
                <Power className="h-4 w-4" /> Desconectar e gerar novo QR
              </button>
            </div>
          )}

          {acao && <p className="mt-3 text-sm text-slate-600">{acao}</p>}

          {qr && (
            <div className="mt-4">
              <p className="mb-2 text-sm text-slate-600">Escaneie com o WhatsApp do <b>chip de disparos</b> (Aparelhos conectados → Conectar um aparelho) e <b>mantenha o celular ligado com internet por alguns minutos</b>:</p>
              <img src={qr} alt="QR Code" className="h-64 w-64 rounded-lg border border-slate-200" />
            </div>
          )}
        </div>

        {/* Recebimento (webhook) — sem isto, as mensagens que chegam não caem no chat */}
        <div className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-700">Recebimento de mensagens (webhook)</div>
              <p className="mt-0.5 text-xs text-slate-500">O WAHA precisa avisar o CRM quando chega mensagem. Sem isto, o chat não recebe.</p>
            </div>
            {whRegistrado === true ? (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-green-600"><CheckCircle2 className="h-4 w-4" /> Registrado</span>
            ) : whRegistrado === false ? (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-red-600"><XCircle className="h-4 w-4" /> Não registrado</span>
            ) : null}
          </div>

          {whAlvo && (
            <p className="mt-3 break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">{whAlvo}</p>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={registrarWebhook}
              disabled={whSalvando}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#1A237E] px-4 py-2 text-sm font-medium text-white hover:bg-[#283593] disabled:opacity-60"
            >
              {whSalvando && <Loader2 className="h-4 w-4 animate-spin" />} Registrar webhook de recebimento
            </button>
            {whMsg && <span className="text-sm text-slate-600">{whMsg}</span>}
          </div>
        </div>

        <p className="mt-4 text-xs text-slate-400">
          Rollback: apague <code className="rounded bg-slate-100 px-1">WHATSAPP_PROVIDER</code> na Vercel para os disparos voltarem ao Evolution na hora.
        </p>
      </div>
    </div>
  )
}
