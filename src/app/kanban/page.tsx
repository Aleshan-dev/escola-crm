'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { LeadDetailModal } from '@/components/LeadDetailModal'
import { NewLeadModal } from '@/components/NewLeadModal'
import type { Coluna, Lead } from '@/lib/types'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { Bot, MessageSquare, Plus, Search, Loader2, Clock, Send } from 'lucide-react'
import Link from 'next/link'

function diasNaEtapa(entrou: string): number {
  const ms = Date.now() - new Date(entrou).getTime()
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)))
}

export default function KanbanPage() {
  const supabase = createClient()
  const [colunas, setColunas] = useState<Coluna[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [activeLead, setActiveLead] = useState<Lead | null>(null)
  const [busca, setBusca] = useState('')
  const [detalhe, setDetalhe] = useState<Lead | null>(null)
  const [novoLead, setNovoLead] = useState(false)

  async function load() {
    setLoading(true)
    const [cols, lds] = await Promise.all([
      supabase.from('colunas').select('*').order('ordem'),
      supabase
        .from('leads')
        .select('*, familia:familias(*), crianca:criancas(*)')
        .eq('arquivado', false)
        .order('criado_em', { ascending: false }),
    ])
    if (cols.data) setColunas(cols.data as Coluna[])
    if (lds.data) setLeads(lds.data as unknown as Lead[])
    setLoading(false)
  }

  useEffect(() => {
    load()
    const channel = supabase
      .channel('leads-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => load())
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const leadsFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase()
    if (!q) return leads
    return leads.filter((l) => {
      const resp = l.familia?.nome_responsavel?.toLowerCase() || ''
      const tel = l.familia?.telefone?.toLowerCase() || ''
      const cri = l.crianca?.nome?.toLowerCase() || ''
      return resp.includes(q) || tel.includes(q) || cri.includes(q)
    })
  }, [leads, busca])

  function handleDragStart(event: DragStartEvent) {
    const lead = leads.find((l) => l.id === event.active.id)
    setActiveLead(lead || null)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveLead(null)
    const leadId = event.active.id as string
    const newColunaId = event.over?.id as string | undefined
    if (!newColunaId) return
    const lead = leads.find((l) => l.id === leadId)
    if (!lead || lead.coluna_id === newColunaId) return
    const agora = new Date().toISOString()
    setLeads((prev) =>
      prev.map((l) => (l.id === leadId ? { ...l, coluna_id: newColunaId, entrou_coluna_em: agora } : l))
    )
    await supabase.from('leads').update({ coluna_id: newColunaId, entrou_coluna_em: agora }).eq('id', leadId)

    // Desfecho do funil -> notifica o gestor (fire-and-forget)
    const nomeCol = colunas.find((c) => c.id === newColunaId)?.nome || ''
    if (/matric|perdid/i.test(nomeCol)) {
      fetch('/api/notificar-desfecho', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId, coluna: nomeCol }),
      }).catch(() => {})
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Topbar />

      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 bg-white">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por responsável, telefone ou criança..."
            className="w-full rounded-lg border border-slate-200 pl-9 pr-3 py-2 text-sm outline-none focus:border-blue-400"
          />
        </div>
        <span className="text-xs text-slate-500">{leadsFiltrados.length} lead(s)</span>
        <Link href="/arquivados" className="text-xs text-slate-500 hover:text-slate-700 underline">Arquivados</Link>
      </div>

      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-96 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Carregando funil...
          </div>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="overflow-x-auto p-4">
              <div className="flex gap-3 min-w-max">
                {colunas.map((col) => (
                  <ColunaView
                    key={col.id}
                    coluna={col}
                    leads={leadsFiltrados.filter((l) => l.coluna_id === col.id)}
                    onOpen={setDetalhe}
                  />
                ))}
              </div>
            </div>
            <DragOverlay>{activeLead ? <CardLead lead={activeLead} dragging /> : null}</DragOverlay>
          </DndContext>
        )}
      </div>

      <button
        onClick={() => setNovoLead(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-blue-600 px-5 py-3 text-sm font-medium text-white shadow-lg hover:bg-blue-700"
      >
        <Plus className="w-5 h-5" />
        Novo lead
      </button>

      {detalhe && (
        <LeadDetailModal
          lead={detalhe}
          colunas={colunas}
          onClose={() => setDetalhe(null)}
        />
      )}
      {novoLead && <NewLeadModal colunas={colunas} onClose={() => setNovoLead(false)} onCreated={load} />}
    </div>
  )
}

function ColunaView({
  coluna,
  leads,
  onOpen,
}: {
  coluna: Coluna
  leads: Lead[]
  onOpen: (lead: Lead) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: coluna.id })
  return (
    <div
      ref={setNodeRef}
      className={`w-[260px] flex-shrink-0 bg-slate-100 rounded-xl p-2.5 transition ${
        isOver ? 'bg-blue-50 ring-2 ring-blue-300' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: coluna.cor }} />
          <span className="text-sm font-medium" style={{ color: coluna.cor }}>
            {coluna.nome}
          </span>
        </div>
        <span className="text-[11px] bg-white border border-slate-200 rounded-full px-2 py-0.5 text-slate-600">
          {leads.length}
        </span>
      </div>
      <div className="space-y-2">
        {leads.map((lead) => (
          <CardLead key={lead.id} lead={lead} onOpen={onOpen} />
        ))}
        {leads.length === 0 && (
          <div className="text-center text-xs text-slate-400 py-6 border border-dashed border-slate-300 rounded-lg">
            Sem leads
          </div>
        )}
      </div>
    </div>
  )
}

function CardLead({
  lead,
  dragging,
  onOpen,
}: {
  lead: Lead
  dragging?: boolean
  onOpen?: (lead: Lead) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id })

  const tempColor =
    lead.temperatura === 'quente'
      ? 'bg-red-100 text-red-700'
      : lead.temperatura === 'morno'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-slate-100 text-slate-600'

  const dias = diasNaEtapa(lead.entrou_coluna_em)
  const diasColor =
    dias >= 7 ? 'bg-red-100 text-red-700' : dias >= 3 ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onOpen?.(lead)}
      className={`bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm hover:border-blue-300 cursor-grab active:cursor-grabbing ${
        isDragging || dragging ? 'opacity-30' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{lead.familia?.nome_responsavel || 'Sem nome'}</div>
          {lead.crianca && (
            <div className="text-xs text-slate-500 truncate">
              {lead.crianca.nome}
              {lead.crianca.idade ? `, ${lead.crianca.idade}a` : ''}
            </div>
          )}
        </div>
        {lead.ia_ativa && <Bot className="w-3.5 h-3.5 text-green-600 flex-shrink-0 mt-0.5" />}
      </div>

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${tempColor}`}>{lead.temperatura}</span>
        {lead.sugestao_matricula && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold"
            title="Sara sugere matrícula — confirme movendo o lead para Matriculados"
          >
            🎓 Sugere matrícula
          </span>
        )}
        {lead.cog_temperatura === 'pronto_visita' && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold"
            title="Leitura da Sara: pronto para visita"
          >
            ⭐ Pronto p/ visita
          </span>
        )}
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${diasColor}`}>
          <Clock className="w-2.5 h-2.5" />
          {dias === 0 ? 'hoje' : `${dias}d`}
        </span>
        {lead.tags?.slice(0, 2).map((t) => (
          <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
            {t}
          </span>
        ))}
        {(lead.followup_count ?? 0) > 0 && lead.followup_status !== 'esgotado' && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 inline-flex items-center gap-1"
            title="Sara fez follow-up automático"
          >
            <Send className="w-2.5 h-2.5" />
            {lead.followup_count}
          </span>
        )}
        {lead.followup_status === 'esgotado' && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500"
            title="Follow-up automático esgotado (sem resposta após várias tentativas)"
          >
            follow-up esgotado
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{
              width: `${lead.score}%`,
              background: lead.score >= 66 ? '#16a34a' : lead.score >= 33 ? '#d97706' : '#dc2626',
            }}
          />
        </div>
        <span className="text-[10px] text-slate-500 font-medium">{lead.score}</span>
        <Link
          href={`/chat?lead=${lead.id}`}
          className="text-slate-400 hover:text-blue-600"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <MessageSquare className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  )
}
