'use client'

import { Topbar } from '@/components/Topbar'
import Link from 'next/link'
import {
  GraduationCap, Clock, Target, Filter, CalendarCheck, XCircle, Globe,
  MessageSquareText, FileText, Workflow, Bot, BookOpen, ChevronRight,
  type LucideIcon,
} from 'lucide-react'

type Item = { titulo: string; descricao: string; href?: string; icon: LucideIcon }

const secoes: { nome: string; itens: Item[] }[] = [
  {
    nome: 'Inteligência (Sara)',
    itens: [
      { titulo: 'Comportamento da Sara', descricao: 'Prompt, modelo e tom de voz da assistente.', href: '/configuracoes/sara', icon: Bot },
      { titulo: 'Base de conhecimento', descricao: 'Perguntas e respostas que a Sara usa.', href: '/configuracoes/sara', icon: BookOpen },
    ],
  },
  {
    nome: 'Escola',
    itens: [
      { titulo: 'Séries da escola', descricao: 'Cadastre as séries ofertadas.', href: '/configuracoes/series', icon: GraduationCap },
      { titulo: 'Turnos disponíveis', descricao: 'Defina os turnos de funcionamento.', href: '/configuracoes/turnos', icon: Clock },
      { titulo: 'Metas de crescimento', descricao: 'Metas de captação por etapa.', href: '/configuracoes/metas', icon: Target },
    ],
  },
  {
    nome: 'Captação',
    itens: [
      { titulo: 'Funis de captação', descricao: 'Crie e edite os funis e etapas.', icon: Filter },
      { titulo: 'Horários de visita', descricao: 'Horários disponíveis para visitas.', href: '/configuracoes/horarios-visita', icon: CalendarCheck },
      { titulo: 'Motivos de perda', descricao: 'Padronize os motivos de perda.', href: '/configuracoes/motivos', icon: XCircle },
      { titulo: 'Origem dos interessados', descricao: 'Canais de entrada de leads.', href: '/configuracoes/origens', icon: Globe },
    ],
  },
  {
    nome: 'Conversas',
    itens: [
      { titulo: 'Mensagens padronizadas', descricao: 'Respostas prontas para agilizar.', icon: MessageSquareText },
      { titulo: 'Templates de WhatsApp', descricao: 'Templates aprovados para campanhas.', icon: FileText },
      { titulo: 'Automações', descricao: 'Fluxos automáticos de conversa.', icon: Workflow },
    ],
  },
  {
    nome: 'Integrações',
    itens: [
      { titulo: 'Google Agenda', descricao: 'Sincronize visitas com o Google Calendar.', href: '/configuracoes/integracoes', icon: CalendarCheck },
      { titulo: 'WhatsApp (Evolution)', descricao: 'Status e conexão do WhatsApp da escola.', href: '/configuracoes/whatsapp', icon: MessageSquareText },
    ],
  },
]

export default function ConfiguracoesPage() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-6xl mx-auto w-full">
        <h1 className="text-xl font-semibold">Configurações</h1>
        <p className="text-sm text-slate-500 mb-6">Configure a escola, a captação e a Sara.</p>
        <div className="space-y-8">
          {secoes.map((sec) => (
            <section key={sec.nome}>
              <h2 className="text-sm font-semibold text-slate-700 mb-3">{sec.nome}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sec.itens.map((item) => {
                  const Icon = item.icon
                  const inner = (
                    <div className={`h-full rounded-xl border bg-white p-4 transition ${item.href ? 'border-slate-200 hover:border-blue-300 hover:shadow-sm' : 'border-dashed border-slate-200 opacity-70'}`}>
                      <div className="flex items-start gap-3">
                        <div className="rounded-lg bg-blue-50 p-2 text-blue-600"><Icon className="w-5 h-5" /></div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{item.titulo}</span>
                            {!item.href && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">Em breve</span>}
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">{item.descricao}</p>
                        </div>
                        {item.href && <ChevronRight className="w-4 h-4 text-slate-300 ml-auto" />}
                      </div>
                    </div>
                  )
                  return item.href ? (
                    <Link key={item.titulo} href={item.href}>{inner}</Link>
                  ) : (
                    <div key={item.titulo}>{inner}</div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
