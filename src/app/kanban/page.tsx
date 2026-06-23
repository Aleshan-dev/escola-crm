'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import type { Coluna, Lead } from '@/lib/types'
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { Bot, MessageSquare, Plus, Loader2 } from 'lucide-react'
import Link from 'next/link'

export default function KanbanPage() {
  const supabase = createClient()
  const [colunas, setColunas] = useState<Coluna[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [activeLead, setActiveLead] = useState<Lead | null>(null)

  async function load() {
    setLoading(true)
    const [cols, lds] = await Promise.all([
      supabase.from('colunas').select('*').order('ordem'),
      supabase.from('leads').select('*, familia:familias(*), crianca:criancas(*)').order('criado_em', { ascending: false }),
    ])
    if (cols.data) setColunas(cols.data)
    if (lds.data) setLeads(lds.data as Lead[])
    setLoading(false)
  }

  useEffect(() => {
    load()

    // Realtime: escuta mudanças em leads
    const channel = supabase
      .channel('leads-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => load())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleDragStart(e: DragStartEvent) {
    const lead = leads.find((l) => l.id === e.active.id)
    setActiveLead(lead || null)
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveLead(null)
    const leadId = e.active.id as string
    const newColunaId = e.over?.id as string | undefined
    if (!newColunaId) return

    const lead = leads.find((l) => l.id === leadId)
    if (!lead || lead.coluna_id === newColunaId) return

    // Atualiza otimisticamente
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, coluna_id: newColunaId } : l)))

    // Persiste
    await supabase.from('leads').update({ coluna_id: newColunaId }).eq('id', leadId)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Topbar />

      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-96 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando funil...
          </div>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="overflow-x-auto p-4">
              <div className="flex gap-3 min-w-max">
                {colunas.map((col) => (
                  <ColunaView
                    key={col.id}
                    coluna={col}
                    leads={leads.filter((l) => l.coluna_id === col.id)}
                  />
                ))}
              </div>
            </div>

            <DragOverlay>
              {activeLead && <CardLead lead={activeLead} dragging />}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </div>
  )
}

function ColunaView({ coluna, leads }: { coluna: Coluna; leads: Lead[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: coluna.id })
  return (
    <div
      ref={setNodeRef}
      className={`w-[260px] flex-shrink-0 bg-slate-100 rounded-xl p-2.5 transition ${isOver ? 'bg-blue-50 ring-2 ring-blue-300' : ''}`}
    >
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: coluna.cor }} />
          <span className="text-sm font-medium" style={{ color: coluna.cor }}>{coluna.nome}</span>
        </div>
        <span className="text-[11px] bg-white border border-slate-200 rounded-full px-2 py-0.5 text-slate-600">
          {leads.length}
        </span>
      </div>

      <div className="space-y-2">
        {leads.map((l) => <CardLead key={l.id} lead={l} />)}
        {leads.length === 0 && (
          <div className="text-center text-xs text-slate-400 py-6 border border-dashed border-slate-300 rounded-lg">
            Sem leads
          </div>
        )}
      </div>
    </div>
  )
}

function CardLead({ lead, dragging }: { lead: Lead; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id })

  const tempColor = lead.temperatura === 'quente' ? 'bg-red-100 text-red-700' : lead.temperatura === 'morno' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm hover:border-blue-300 cursor-grab active:cursor-grabbing transition ${isDragging && !dragging ? 'opacity-30' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{lead.familia?.nome_responsavel || 'Sem nome'}</div>
          {lead.crianca && <div className="text-xs text-slate-500 truncate">{lead.crianca.nome}{lead.crianca.idade ? `, ${lead.crianca.idade}a` : ''}</div>}
        </div>
        {lead.ia_ativa && <Bot className="w-3.5 h-3.5 text-green-600 flex-shrink-0 mt-0.5" />}
      </div>

      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${tempColor}`}>
          {lead.temperatura}
        </span>
        {lead.tags?.slice(0, 2).map((t) => (
          <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{t}</span>
        ))}
      </div>

      <div className="flex items-center gap-2 mt-2">
        <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full"
            style={{
              width: `${lead.score}%`,
              background: lead.score > 70 ? '#16a34a' : lead.score > 40 ? '#d97706' : '#dc2626',
            }}
          />
        </div>
        <span className="text-[10px] text-slate-500 font-medium">{lead.score}</span>
        <Link href={`/chat?lead=${lead.id}`} className="text-slate-400 hover:text-blue-600" onPointerDown={(e) => e.stopPropagation()}>
          <MessageSquare className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  )
}
