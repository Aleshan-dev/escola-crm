'use client'

import type { Coluna, Lead } from '@/lib/types'
import { X, Bot, MessageSquare, Phone, Mail, Baby, Thermometer, Calendar } from 'lucide-react'
import Link from 'next/link'

function diasNaEtapa(entrou: string): number {
  const ms = Date.now() - new Date(entrou).getTime()
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)))
}

const TEMP_LABEL: Record<Lead['temperatura'], string> = {
  frio: 'Frio',
  morno: 'Morno',
  quente: 'Quente',
}
const TEMP_CLASS: Record<Lead['temperatura'], string> = {
  frio: 'bg-slate-100 text-slate-600',
  morno: 'bg-amber-100 text-amber-700',
  quente: 'bg-red-100 text-red-700',
}

export function LeadDetailModal({
  lead,
  coluna,
  onClose,
}: {
  lead: Lead
  coluna?: Coluna
  onClose: () => void
}) {
  const dias = diasNaEtapa(lead.entrou_coluna_em)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold truncate">
              {lead.familia?.nome_responsavel || 'Sem nome'}
            </h2>
            {coluna && (
              <span className="text-xs font-medium" style={{ color: coluna.cor }}>
                {coluna.nome}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Fechar">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${TEMP_CLASS[lead.temperatura]}`}>
              <Thermometer className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
              {TEMP_LABEL[lead.temperatura]}
            </span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">
              Score {lead.score}
            </span>
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                dias >= 7 ? 'bg-red-100 text-red-700' : dias >= 3 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'
              }`}
            >
              <Calendar className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
              {dias === 0 ? 'Entrou hoje' : `${dias}d na etapa`}
            </span>
            {lead.ia_ativa && (
              <span className="text-xs px-2.5 py-1 rounded-full bg-green-100 text-green-700 font-medium">
                <Bot className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
                Sara ativa
              </span>
            )}
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-slate-700">
              <Phone className="w-4 h-4 text-slate-400" />
              {lead.familia?.telefone || '—'}
            </div>
            {lead.familia?.email && (
              <div className="flex items-center gap-2 text-slate-700">
                <Mail className="w-4 h-4 text-slate-400" />
                {lead.familia.email}
              </div>
            )}
          </div>

          {lead.crianca && (
            <div className="rounded-xl bg-slate-50 p-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-slate-700 mb-1">
                <Baby className="w-4 h-4 text-slate-400" />
                {lead.crianca.nome}
              </div>
              <div className="text-slate-500 text-xs space-y-0.5">
                {lead.crianca.idade != null && <div>Idade: {lead.crianca.idade} anos</div>}
                {lead.crianca.serie_desejada && <div>Série desejada: {lead.crianca.serie_desejada}</div>}
                {lead.crianca.periodo && <div>Período: {lead.crianca.periodo}</div>}
              </div>
            </div>
          )}

          {lead.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {lead.tags.map((t) => (
                <span key={t} className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                  {t}
                </span>
              ))}
            </div>
          )}

          {lead.proxima_acao && (
            <div className="text-sm">
              <span className="text-slate-400">Próxima ação: </span>
              <span className="text-slate-700">{lead.proxima_acao}</span>
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 p-4">
          <Link
            href={`/chat?lead=${lead.id}`}
            className="flex items-center justify-center gap-2 w-full rounded-lg bg-blue-600 text-white text-sm font-medium py-2.5 hover:bg-blue-700"
          >
            <MessageSquare className="w-4 h-4" />
            Abrir conversa
          </Link>
        </div>
      </div>
    </div>
  )
}
