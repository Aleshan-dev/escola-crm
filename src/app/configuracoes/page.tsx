'use client'

import { Topbar } from '@/components/Topbar'
import { BotaoRodarCron } from '@/components/BotaoRodarCron'
import { BotaoCriarTemplate } from '@/components/BotaoCriarTemplate'
import Link from 'next/link'
import {
  GraduationCap, Clock, Target, Filter, CalendarCheck, XCircle, Globe,
  MessageSquareText, FileText, Workflow, Bot, BookOpen, ChevronRight, DollarSign, Bell,
  Wallet, ClipboardCheck, KeyRound, ShieldCheck,
  type LucideIcon,
} from 'lucide-react'

type Item = { titulo: string; descricao: string; href?: string; icon: LucideIcon }

const secoes: { nome: string; itens: Item[] }[] = [
  {
    nome: 'Maestro Guardião',
    itens: [
      { titulo: 'Conversar com o Maestro', descricao: 'Dê instruções em linguagem natural; ele propõe mudanças e você aplica com um clique.', href: '/configuracoes/maestro', icon: ShieldCheck },
    ],
  },
  {
    nome: 'Inteligência (Sara)',
    itens: [
      { titulo: 'Comportamento da Sara', descricao: 'Prompt, modelo e tom de voz da assistente.', href: '/configuracoes/sara', icon: Bot },
      { titulo: 'Base de conhecimento', descricao: 'Perguntas e respostas que a Sara usa.', href: '/configuracoes/sara', icon: BookOpen },
      { titulo: 'Follow-up automático', descricao: 'Ligar/desligar e testar o follow-up por lead (preview).', href: '/configuracoes/followup', icon: Workflow },
      { titulo: 'Notificações do gestor', descricao: 'Número do gestor e eventos que avisam por WhatsApp.', href: '/configuracoes/notificacoes', icon: Bell },
    ],
  },
  {
    nome: 'Inteligência (Salomão)',
    itens: [
      { titulo: 'Comportamento do Salomão', descricao: 'Ativar, modelo, tom e canais de pagamento do atendente de matriculados.', href: '/configuracoes/salomao', icon: Wallet },
      { titulo: 'Auditoria do Salomão', descricao: 'Gabarito de qualidade das conversas (5 critérios).', href: '/configuracoes/salomao/auditoria', icon: ClipboardCheck },
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
      { titulo: 'Investimento por canal', descricao: 'Lance o gasto por canal para calcular o CAC.', href: '/configuracoes/investimento', icon: DollarSign },
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
      { titulo: 'Credenciais de IA', descricao: 'Chaves dos provedores (OpenAI, OpenRouter, DeepSeek) e qual agente usa cada uma.', href: '/configuracoes/credenciais', icon: KeyRound },
      { titulo: 'Google Agenda', descricao: 'Sincronize visitas com o Google Calendar.', href: '/configuracoes/integracoes', icon: CalendarCheck },
      { titulo: 'WhatsApp Disparos (WAHA)', descricao: 'Conexão do canal de disparos (Salomão/convites). Chip SEPARADO do atendimento.', href: '/configuracoes/waha', icon: MessageSquareText },
      { titulo: 'WhatsApp (Evolution)', descricao: 'Canal de disparos legado (rollback do WAHA).', href: '/configuracoes/whatsapp', icon: MessageSquareText },
      { titulo: 'WhatsApp Oficial (Meta)', descricao: 'Canal pela API oficial da Meta (Cloud API).', href: '/configuracoes/whatsapp-oficial', icon: MessageSquareText },
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

          <section>
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Manutenção</h2>
            <div className="space-y-3">
              <BotaoRodarCron />
              <BotaoCriarTemplate />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
