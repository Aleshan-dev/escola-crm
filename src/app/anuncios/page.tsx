'use client'

import { useEffect, useState } from 'react'
import { Topbar } from '@/components/Topbar'
import { Loader2, AlertTriangle, Settings2, RefreshCw } from 'lucide-react'

type Linha = {
  chave: string
  adId: string | null
  campanha: string | null
  titulo: string | null
  thumbnail: string | null
  leads: number
  qualificados: number
  visitasAgendadas: number
  visitasRealizadas: number
  matriculas: number
  quentes: number
  spend: number | null
  impressions: number | null
  cpm: number | null
  ctr: number | null
  conversasMeta: number | null
  custoPorLead: number | null
  custoPorVisita: number | null
  custoPorMatricula: number | null
}

type Resposta = {
  dias: number
  desde: string
  ate: string
  metaOk: boolean
  metaErro: string | null
  linhas: Linha[]
}

const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

function fmtBRL(v: number | null) {
  if (v == null) return '—'
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
function fmtInt(v: number | null) {
  return v == null ? '—' : v.toLocaleString('pt-BR')
}
function nomeAnuncio(l: Linha) {
  return l.titulo || l.campanha || (l.adId ? `Anúncio ${l.adId}` : 'Sem campanha')
}

export default function AnunciosPage() {
  const [dados, setDados] = useState<Resposta | null>(null)
  const [loading, setLoading] = useState(true)
  const [dias, setDias] = useState(180)
  const [configAberto, setConfigAberto] = useState(false)
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [msgConfig, setMsgConfig] = useState<string | null>(null)

  async function load(d = dias) {
    setLoading(true)
    try {
      const r = await fetch(`/api/anuncios?dias=${d}`)
      const j = (await r.json()) as Resposta
      setDados(j)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    // setState só após o await (fora do corpo síncrono do efeito), por react-hooks/set-state-in-effect.
    let alive = true
    fetch(`/api/anuncios?dias=${dias}`)
      .then((r) => r.json())
      .then((j) => {
        if (alive) setDados(j as Resposta)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function salvarConfig() {
    setSalvando(true)
    setMsgConfig(null)
    try {
      const r = await fetch('/api/anuncios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token || undefined, accountId: accountId || undefined }),
      })
      const j = await r.json()
      if (!r.ok) {
        setMsgConfig(j.error || 'Falha ao salvar.')
      } else {
        setMsgConfig('Salvo. Atualizando o gasto...')
        setToken('')
        await load()
        setConfigAberto(false)
      }
    } finally {
      setSalvando(false)
    }
  }

  const linhas = dados?.linhas || []
  const tot = linhas.reduce(
    (a, l) => ({
      spend: a.spend + (l.spend || 0),
      leads: a.leads + l.leads,
      visitasAgendadas: a.visitasAgendadas + l.visitasAgendadas,
      matriculas: a.matriculas + l.matriculas,
    }),
    { spend: 0, leads: 0, visitasAgendadas: 0, matriculas: 0 }
  )

  return (
    <div className="min-h-screen bg-slate-50">
      <Topbar />
      <div className="ml-16 p-5 max-w-6xl">
        <div className="flex items-center justify-between gap-3 mb-1">
          <h1 className="text-xl font-semibold">Acompanhamento de anúncios</h1>
          <div className="flex items-center gap-2">
            <select
              value={dias}
              onChange={(e) => {
                const d = Number(e.target.value)
                setDias(d)
                load(d)
              }}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none"
            >
              <option value={30}>Últimos 30 dias</option>
              <option value={90}>Últimos 90 dias</option>
              <option value={180}>Últimos 180 dias</option>
              <option value={365}>Último ano</option>
            </select>
            <button onClick={() => load()} title="Atualizar" className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-100">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button onClick={() => setConfigAberto((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
              <Settings2 className="h-4 w-4" /> Meta API
            </button>
          </div>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Leads reais que chegaram por anúncio, do contato à matrícula, cruzados com o gasto do Meta.
          {dados && <span className="text-slate-400"> · {dados.desde} a {dados.ate}</span>}
        </p>

        {configAberto && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 mb-4">
            <p className="text-sm font-medium text-slate-700 mb-1">Credenciais da API de Marketing do Meta</p>
            <p className="text-xs text-slate-500 mb-3">
              Token de System User com permissão <code>ads_read</code> e o ID da conta de anúncios. O token é guardado no servidor e nunca é exibido de volta.
            </p>
            <div className="grid sm:grid-cols-[1fr_200px_auto] gap-2 items-end">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">Token do Meta</span>
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className={inputCls} placeholder="(deixe em branco para manter o atual)" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-500">ID da conta</span>
                <input value={accountId} onChange={(e) => setAccountId(e.target.value)} className={inputCls} placeholder="27431329599889819" />
              </label>
              <button onClick={salvarConfig} disabled={salvando} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Salvar
              </button>
            </div>
            {msgConfig && <p className="text-sm text-slate-600 mt-2">{msgConfig}</p>}
          </div>
        )}

        {dados && !dados.metaOk && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 mb-4 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <span className="font-medium">Gasto indisponível.</span> {dados.metaErro} O funil de leads por anúncio abaixo continua válido; configure a Meta API para ver custo por resultado.
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="h-5 w-5 animate-spin" /> Carregando...</div>
        ) : linhas.length === 0 ? (
          <p className="text-sm text-slate-400">Nenhum lead de anúncio no período.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <Tile titulo="Gasto total" valor={fmtBRL(tot.spend || null)} />
              <Tile titulo="Conversas" valor={fmtInt(tot.leads)} />
              <Tile titulo="Visitas agendadas" valor={fmtInt(tot.visitasAgendadas)} />
              <Tile titulo="Matrículas" valor={fmtInt(tot.matriculas)} />
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                    <th className="px-3 py-2">Anúncio</th>
                    <th className="px-3 py-2 text-right">Gasto</th>
                    <th className="px-3 py-2 text-right">Conversas</th>
                    <th className="px-3 py-2 text-right">Qualif.</th>
                    <th className="px-3 py-2 text-right">V. agend.</th>
                    <th className="px-3 py-2 text-right">V. realiz.</th>
                    <th className="px-3 py-2 text-right">Matríc.</th>
                    <th className="px-3 py-2 text-right">R$/conversa</th>
                    <th className="px-3 py-2 text-right">R$/visita</th>
                    <th className="px-3 py-2 text-right">R$/matríc.</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => (
                    <tr key={l.chave} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-700">{nomeAnuncio(l)}</div>
                        <div className="text-xs text-slate-400">
                          {l.adId ? `ad ${l.adId}` : 'por campanha (sem id de anúncio)'}
                          {l.quentes > 0 && <span className="ml-2 text-rose-500">{l.quentes} quentes</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtBRL(l.spend)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(l.leads)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(l.qualificados)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(l.visitasAgendadas)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtInt(l.visitasRealizadas)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtInt(l.matriculas)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtBRL(l.custoPorLead)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtBRL(l.custoPorVisita)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtBRL(l.custoPorMatricula)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400 mt-3">
              Conversas = famílias que chegaram pelo anúncio (1 por contato). Qualificado = criança identificada ou interesse ≥ 3. Matrículas vêm do funil de matrícula (convertido_em).
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ titulo, valor }: { titulo: string; valor: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-400">{titulo}</div>
      <div className="text-xl font-semibold text-slate-800">{valor}</div>
    </div>
  )
}
