'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Topbar } from '@/components/Topbar'
import { ArrowLeft, Loader2 } from 'lucide-react'

type Linha = { id: string; lead_id: string; canal: string; rota: string; motivo: string; permite: boolean; intencao: string | null; confianca: number | null; resultado: string | null; criado_em: string }
type Resp = {
  dias: number
  total: number
  porRota: Record<string, number>
  porResultado: Record<string, number>
  porIntencao: Record<string, number>
  porMotivo: Record<string, number>
  ultimas: Linha[]
}

function Bloco({ titulo, dados }: { titulo: string; dados: Record<string, number> }) {
  const itens = Object.entries(dados).sort((a, b) => b[1] - a[1])
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <div className="font-semibold text-slate-700 mb-1">{titulo}</div>
      {itens.length === 0 ? <div className="text-xs text-slate-400">sem dados</div> :
        itens.map(([k, n]) => <div key={k} className="flex justify-between gap-2"><span className="truncate">{k}</span><b>{n}</b></div>)}
    </div>
  )
}

export default function DecisoesRoteadorPage() {
  const [dias, setDias] = useState(7)
  const [d, setD] = useState<Resp | null>(null)

  useEffect(() => {
    fetch(`/api/roteador/decisoes?dias=${dias}`).then((r) => r.json()).then(setD)
  }, [dias])

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-4xl mx-auto w-full">
        <Link href="/configuracoes/roteador" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Roteador
        </Link>
        <div className="flex items-center justify-between gap-3 mb-1">
          <h1 className="text-xl font-semibold">Decisões do roteador</h1>
          <select className="rounded-lg border border-slate-200 px-2 py-1 text-sm" value={dias} onChange={(e) => { setD(null); setDias(Number(e.target.value)) }}>
            {[1, 7, 30, 90].map((n) => <option key={n} value={n}>últimos {n} dia(s)</option>)}
          </select>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Uma linha por mensagem roteada (quando o Maestro ou o classificador estão ligados). Não guarda o texto da conversa.
        </p>
        {!d ? (
          <div className="flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
        ) : (
          <>
            <div className="text-sm mb-3">{d.total} decisão(ões)</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
              <Bloco titulo="Agente" dados={d.porRota} />
              <Bloco titulo="Resultado" dados={d.porResultado} />
              <Bloco titulo="Intenção" dados={d.porIntencao} />
              <Bloco titulo="Motivo da regra" dados={d.porMotivo} />
            </div>
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500"><tr>
                  <th className="text-left p-2">Quando</th><th className="text-left p-2">Agente</th><th className="text-left p-2">Resultado</th>
                  <th className="text-left p-2">Intenção</th><th className="text-right p-2">Conf.</th><th className="text-left p-2">Lead</th>
                </tr></thead>
                <tbody>
                  {d.ultimas.map((l) => (
                    <tr key={l.id} className="border-t border-slate-100">
                      <td className="p-2 whitespace-nowrap">{new Date(l.criado_em).toLocaleString('pt-BR')}</td>
                      <td className="p-2">{l.rota}</td>
                      <td className="p-2">{l.resultado ?? 'guarda'}</td>
                      <td className="p-2">{l.intencao ?? '—'}</td>
                      <td className="p-2 text-right">{l.confianca != null ? `${Math.round(Number(l.confianca) * 100)}%` : '—'}</td>
                      <td className="p-2"><Link className="text-blue-600 hover:underline" href={`/chat?lead=${l.lead_id}`}>abrir</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
