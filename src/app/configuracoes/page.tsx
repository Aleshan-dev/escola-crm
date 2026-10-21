'use client'

import { Topbar } from '@/components/Topbar'
import { BotaoRodarCron } from '@/components/BotaoRodarCron'
import { BotaoCriarTemplate } from '@/components/BotaoCriarTemplate'
import Link from 'next/link'
import {
  GraduationCap, Clock, Target, CalendarCheck, XCircle, Globe, MessageSquareText, Workflow, Bot,
  BookOpen, ChevronRight, DollarSign, Bell, BellRing, Wallet, ClipboardCheck, KeyRound, ShieldCheck,
  Route, BarChart3, Shield, ToggleRight, Sparkles, type LucideIcon,
} from 'lucide-react'

// Organização em hubs (inspirada no DeskcommCRM): o trabalho diário fica no menu do
// topo; aqui fica a configuração ocasional, agrupada por responsabilidade. Nenhuma
// URL mudou — só a forma de encontrar cada tela.

type Item = { titulo: string; descricao: string; href: string; icon: LucideIcon }
type Grupo = { nome?: string; itens: Item[] }
type Hub = { nome: string; resumo: string; glossario?: string; grupos: Grupo[] }

const HUBS: Hub[] = [
  {
    nome: 'Agentes de IA',
    resumo: 'Montar, ensinar e acompanhar a Sara (captação), o Salomão (matriculados) e o Maestro (supervisor).',
    glossario:
      'Agente = quem conversa e age. Roteador = quem escolhe qual agente atende cada mensagem (não é a distribuição entre pessoas da equipe). ' +
      'Credencial = a chave de acesso a um provedor de IA; o modelo é escolhido na tela de cada agente.',
    grupos: [
      {
        nome: 'Montar',
        itens: [
          { titulo: 'Sara', descricao: 'Prompt, modelo, credencial e tom da assistente de captação.', href: '/configuracoes/sara', icon: Bot },
          { titulo: 'Salomão', descricao: 'Ativar, modelo, tom e canais de pagamento do atendente de matriculados.', href: '/configuracoes/salomao', icon: Wallet },
          { titulo: 'Roteador', descricao: 'Regra do vínculo SGEI + classificador de intenção opcional, com teste.', href: '/configuracoes/roteador', icon: Route },
          { titulo: 'Credenciais de IA', descricao: 'Chaves dos provedores e qual agente usa cada uma.', href: '/configuracoes/credenciais', icon: KeyRound },
          { titulo: 'Follow-up automático', descricao: 'Ligar/desligar e testar o follow-up por lead.', href: '/configuracoes/followup', icon: Workflow },
          { titulo: 'Notificações do gestor', descricao: 'Número do gestor e eventos que avisam por WhatsApp.', href: '/configuracoes/notificacoes', icon: Bell },
        ],
      },
      {
        nome: 'Ensinar',
        itens: [
          { titulo: 'Treinar a Sara', descricao: 'Converse com a Sara para corrigir e ensinar respostas.', href: '/treinar', icon: GraduationCap },
          { titulo: 'Base de conhecimento', descricao: 'Perguntas e respostas que a Sara usa.', href: '/configuracoes/sara', icon: BookOpen },
          { titulo: 'Maestro Guardião', descricao: 'Dê diretrizes em linguagem natural; ele propõe e você aplica com um clique.', href: '/configuracoes/maestro', icon: ShieldCheck },
        ],
      },
      {
        nome: 'Acompanhar',
        itens: [
          { titulo: 'Auditor Cognitivo', descricao: 'Revise as sugestões de melhoria que o auditor tirou das conversas.', href: '/auditoria', icon: Sparkles },
          { titulo: 'Auditoria do Salomão', descricao: 'Gabarito de qualidade das conversas (5 critérios).', href: '/configuracoes/salomao/auditoria', icon: ClipboardCheck },
          { titulo: 'Decisões do roteador', descricao: 'Que agente atendeu, por qual regra e com que intenção.', href: '/configuracoes/roteador/decisoes', icon: BarChart3 },
          { titulo: 'Alertas', descricao: 'Envios manuais pendentes, falhas e avisos do sistema.', href: '/pendentes', icon: BellRing },
        ],
      },
    ],
  },
  {
    nome: 'Canais',
    resumo: 'Os números de WhatsApp e a proteção que vale antes de cada mensagem sair.',
    glossario: 'WAHA e Evolution são o WhatsApp não-oficial (chip): sujeito a bloqueio por volume, por isso a Proteção de envio. A Cloud é a API oficial da Meta.',
    grupos: [
      {
        itens: [
          { titulo: 'Proteção de envio', descricao: 'Horário, intervalo, teto do dia, aquecimento, texto repetido e opt-out por número.', href: '/configuracoes/protecao-envio', icon: Shield },
          { titulo: 'WhatsApp (WAHA)', descricao: 'Conexão do número não-oficial via WAHA.', href: '/configuracoes/waha', icon: MessageSquareText },
          { titulo: 'WhatsApp (Evolution)', descricao: 'Canal não-oficial legado (rollback do WAHA).', href: '/configuracoes/whatsapp', icon: MessageSquareText },
          { titulo: 'WhatsApp Oficial (Meta)', descricao: 'Canal pela API oficial da Meta (Cloud API).', href: '/configuracoes/whatsapp-oficial', icon: MessageSquareText },
        ],
      },
    ],
  },
  {
    nome: 'Escola e captação',
    resumo: 'Os dados da escola que a Sara e os relatórios usam.',
    grupos: [
      {
        itens: [
          { titulo: 'Séries', descricao: 'Séries ofertadas.', href: '/configuracoes/series', icon: GraduationCap },
          { titulo: 'Turnos', descricao: 'Turnos de funcionamento.', href: '/configuracoes/turnos', icon: Clock },
          { titulo: 'Horários de visita', descricao: 'Horários disponíveis para visitas.', href: '/configuracoes/horarios-visita', icon: CalendarCheck },
          { titulo: 'Metas de crescimento', descricao: 'Metas de captação por etapa.', href: '/configuracoes/metas', icon: Target },
          { titulo: 'Motivos de perda', descricao: 'Padronize os motivos de perda.', href: '/configuracoes/motivos', icon: XCircle },
          { titulo: 'Origem dos interessados', descricao: 'Canais de entrada de leads.', href: '/configuracoes/origens', icon: Globe },
          { titulo: 'Investimento por canal', descricao: 'Gasto por canal para calcular o CAC.', href: '/configuracoes/investimento', icon: DollarSign },
        ],
      },
    ],
  },
  {
    nome: 'Sistema',
    resumo: 'Integrações externas e o inventário do que está ligado.',
    grupos: [
      {
        itens: [
          { titulo: 'Recursos e interruptores', descricao: 'O que está ligado/desligado no sistema e onde configurar cada coisa.', href: '/configuracoes/recursos', icon: ToggleRight },
          { titulo: 'Google Agenda', descricao: 'Sincronize visitas com o Google Calendar.', href: '/configuracoes/integracoes', icon: CalendarCheck },
        ],
      },
    ],
  },
]

function Cartao({ item }: { item: Item }) {
  const Icon = item.icon
  return (
    <Link href={item.href}>
      <div className="h-full rounded-xl border border-slate-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-blue-50 p-2 text-blue-600"><Icon className="w-5 h-5" /></div>
          <div className="min-w-0">
            <span className="text-sm font-medium">{item.titulo}</span>
            <p className="text-xs text-slate-500 mt-0.5">{item.descricao}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-300 ml-auto shrink-0" />
        </div>
      </div>
    </Link>
  )
}

export default function ConfiguracoesPage() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-6xl mx-auto w-full">
        <h1 className="text-xl font-semibold">Configurações</h1>
        <p className="text-sm text-slate-500 mb-6">
          O dia a dia (funil, conversas, agenda, alertas) fica no menu de cima. Aqui ficam os ajustes ocasionais, por área.
        </p>
        <div className="space-y-10">
          {HUBS.map((hub) => (
            <section key={hub.nome}>
              <h2 className="text-base font-semibold text-slate-800">{hub.nome}</h2>
              <p className="text-sm text-slate-500">{hub.resumo}</p>
              {hub.glossario && <p className="text-xs text-slate-400 mt-1 max-w-3xl">{hub.glossario}</p>}
              <div className="mt-4 space-y-5">
                {hub.grupos.map((g, i) => (
                  <div key={g.nome ?? i}>
                    {g.nome && <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{g.nome}</h3>}
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {g.itens.map((item) => <Cartao key={item.titulo} item={item} />)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-3">Manutenção</h2>
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
