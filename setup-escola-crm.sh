#!/usr/bin/env bash
# Script gerado automaticamente para criar todos os arquivos do escola-crm
set -e
cd /workspaces/escola-crm

mkdir -p src/lib src/components src/app/login src/app/kanban src/app/chat \
  src/app/api/mensagens/enviar src/app/api/webhook/whatsapp

echo "Pastas criadas. Criando arquivos..."


echo 'Criando .env.local'
cat > .env.local << 'FILE_EOF'
NEXT_PUBLIC_SUPABASE_URL=https://vdtlfzdedrgqhqrevleu.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=COLE_SUA_PUBLISHABLE_KEY_AQUI
SUPABASE_SECRET_KEY=COLE_SUA_SECRET_KEY_AQUI

ANTHROPIC_API_KEY=COLE_SUA_CHAVE_ANTHROPIC_AQUI

EVOLUTION_API_URL=COLE_SUA_URL_EVOLUTION_AQUI
EVOLUTION_API_KEY=COLE_SUA_API_KEY_EVOLUTION_AQUI
EVOLUTION_INSTANCE_NAME=colegio-pequenos-guardioes
FILE_EOF

echo 'Criando src/lib/supabase-browser.ts'
cat > src/lib/supabase-browser.ts << 'FILE_EOF'
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
}
FILE_EOF

echo 'Criando src/lib/supabase-server.ts'
cat > src/lib/supabase-server.ts << 'FILE_EOF'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createClient as createServiceClient } from '@supabase/supabase-js'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component context — pode ignorar
          }
        },
      },
    }
  )
}

// Cliente com chave secreta — bypassa RLS (use só em webhooks confiáveis)
export function createServerAdminClient() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}
FILE_EOF

echo 'Criando src/lib/evolution.ts'
cat > src/lib/evolution.ts << 'FILE_EOF'
const URL = process.env.EVOLUTION_API_URL!
const KEY = process.env.EVOLUTION_API_KEY!
const INSTANCE = process.env.EVOLUTION_INSTANCE_NAME!

export async function evolutionSendText(numero: string, texto: string) {
  const r = await fetch(`${URL}/message/sendText/${INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({
      number: numero,
      text: texto,
    }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Evolution send falhou (${r.status}): ${t}`)
  }
  return r.json()
}

// Limpa número do formato WhatsApp ('5589xxxx@s.whatsapp.net' → '5589xxxx')
export function cleanWhatsappJid(jid: string): string {
  return jid.split('@')[0].split(':')[0]
}
FILE_EOF

echo 'Criando src/lib/sara.ts'
cat > src/lib/sara.ts << 'FILE_EOF'
import Anthropic from '@anthropic-ai/sdk'
import { createServerAdminClient } from '@/lib/supabase-server'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function gerarRespostaSara(leadId: string): Promise<string> {
  const supabase = createServerAdminClient()

  // Pega dados do lead
  const { data: lead } = await supabase
    .from('leads')
    .select('*, familia:familias(*), crianca:criancas(*)')
    .eq('id', leadId)
    .single()

  if (!lead) throw new Error('Lead não encontrado')

  // Configuração da Sara
  const { data: config } = await supabase.from('config_ia').select('*').eq('id', 1).single()

  // Base de conhecimento ativa
  const { data: kb } = await supabase
    .from('base_conhecimento')
    .select('categoria, pergunta, resposta')
    .eq('ativa', true)

  // Últimas 20 mensagens do lead
  const { data: msgs } = await supabase
    .from('mensagens')
    .select('direcao, conteudo, criado_em')
    .eq('lead_id', leadId)
    .order('criado_em', { ascending: false })
    .limit(20)

  const historico = (msgs || []).reverse()

  const systemPrompt = `${config?.system_prompt || 'Você é Sara, consultora de matrículas do Colégio Pequenos Guardiões.'}

INFORMAÇÕES DA ESCOLA (use quando relevante):
${(kb || []).map((k) => `[${k.categoria}] ${k.pergunta}\nResposta: ${k.resposta}`).join('\n\n')}

DADOS QUE JÁ TEM SOBRE ESTA FAMÍLIA:
- Responsável: ${lead.familia?.nome_responsavel || 'não informado'}
- Telefone: ${lead.familia?.telefone}
- Criança: ${lead.crianca?.nome || 'não informado'}${lead.crianca?.idade ? `, ${lead.crianca.idade} anos` : ''}
- Período desejado: ${lead.crianca?.periodo || 'não informado'}
- Score atual: ${lead.score}

REGRAS:
- Não repita perguntas já respondidas no histórico
- Seja acolhedora, profissional e direta
- Sempre proponha um próximo passo concreto
- Mensagens curtas, no máximo 3 linhas
- Se a família demonstrar interesse forte, ofereça visita presencial`

  const messages = historico.map((m) => ({
    role: m.direcao === 'in' ? ('user' as const) : ('assistant' as const),
    content: m.conteudo,
  }))

  const response = await anthropic.messages.create({
    model: config?.modelo || 'claude-sonnet-4-6',
    max_tokens: 500,
    system: systemPrompt,
    messages,
  })

  const textBlock = response.content.find((b) => b.type === 'text')
  return textBlock && 'text' in textBlock ? textBlock.text : 'Desculpe, não consegui responder agora.'
}
FILE_EOF

echo 'Criando src/lib/types.ts'
cat > src/lib/types.ts << 'FILE_EOF'
export type Coluna = {
  id: string
  funil_id: string
  nome: string
  cor: string
  ordem: number
  ia_ativa_default: boolean
}

export type Familia = {
  id: string
  nome_responsavel: string
  telefone: string
  email: string | null
  origem: string | null
}

export type Lead = {
  id: string
  familia_id: string
  crianca_id: string | null
  coluna_id: string
  responsavel_id: string | null
  score: number
  temperatura: 'frio' | 'morno' | 'quente'
  ia_ativa: boolean
  tags: string[]
  motivo_perda: string | null
  proxima_acao: string | null
  data_proxima_acao: string | null
  entrou_coluna_em: string
  criado_em: string
  atualizado_em: string
  familia?: Familia
  crianca?: Crianca | null
}

export type Crianca = {
  id: string
  familia_id: string
  nome: string
  idade: number | null
  serie_desejada: string | null
  periodo: 'matutino' | 'vespertino' | 'integral' | null
}

export type Mensagem = {
  id: string
  lead_id: string
  direcao: 'in' | 'out_humano' | 'out_ia'
  conteudo: string
  tipo_midia: string
  url_midia: string | null
  enviado_por: string | null
  whatsapp_message_id: string | null
  criado_em: string
}
FILE_EOF

echo 'Criando src/middleware.ts'
cat > src/middleware.ts << 'FILE_EOF'
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const url = request.nextUrl
  const isAuthRoute = url.pathname.startsWith('/login')
  const isApiWebhook = url.pathname.startsWith('/api/webhook')

  // Webhooks do WhatsApp não precisam de auth
  if (isApiWebhook) return supabaseResponse

  // Não logado → manda pra login
  if (!user && !isAuthRoute) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Logado e tentando acessar login → manda pro kanban
  if (user && isAuthRoute) {
    return NextResponse.redirect(new URL('/kanban', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.svg).*)'],
}
FILE_EOF

echo 'Criando src/app/layout.tsx'
cat > src/app/layout.tsx << 'FILE_EOF'
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sara CRM — Matrículas",
  description: "CRM e agente IA para matrículas escolares",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="antialiased bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
FILE_EOF

echo 'Criando src/app/globals.css'
cat > src/app/globals.css << 'FILE_EOF'
@import "tailwindcss";

:root {
  --background: #f8fafc;
  --foreground: #0f172a;
}

html, body { height: 100%; }
FILE_EOF

echo 'Criando src/app/page.tsx'
cat > src/app/page.tsx << 'FILE_EOF'
import { redirect } from 'next/navigation'

export default function Home() {
  redirect('/kanban')
}
FILE_EOF

echo 'Criando src/app/login/page.tsx'
cat > src/app/login/page.tsx << 'FILE_EOF'
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { School, Loader2 } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMsg(null)

    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      router.push('/kanban')
      router.refresh()
    } else {
      const { error } = await supabase.auth.signUp({ email, password })
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      setMsg('Conta criada! Verifique seu email e depois faça login.')
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
            <School className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Sara CRM</h1>
            <p className="text-xs text-slate-500">Colégio Pequenos Guardiões</p>
          </div>
        </div>

        <h2 className="text-xl font-semibold mb-1">
          {mode === 'signin' ? 'Bem-vinda de volta' : 'Criar conta'}
        </h2>
        <p className="text-sm text-slate-500 mb-6">
          {mode === 'signin' ? 'Entre com seu email e senha' : 'Use seu email da escola'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              placeholder="seu@email.com"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1.5">Senha</label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              placeholder="••••••••"
            />
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
          {msg && <div className="text-sm text-green-700 bg-green-50 px-3 py-2 rounded-lg">{msg}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm flex items-center justify-center gap-2 transition"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === 'signin' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>

        <p className="text-xs text-center text-slate-500 mt-5">
          {mode === 'signin' ? 'Não tem conta?' : 'Já tem conta?'}{' '}
          <button
            onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setMsg(null); }}
            className="text-blue-600 hover:underline font-medium"
          >
            {mode === 'signin' ? 'Criar uma' : 'Entrar'}
          </button>
        </p>
      </div>
    </main>
  )
}
FILE_EOF

echo 'Criando src/components/Topbar.tsx'
cat > src/components/Topbar.tsx << 'FILE_EOF'
'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { LayoutGrid, MessageSquare, LogOut, School, Bot } from 'lucide-react'

export function Topbar() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const tabs = [
    { href: '/kanban', label: 'Kanban', icon: LayoutGrid },
    { href: '/chat', label: 'Conversas', icon: MessageSquare },
  ]

  return (
    <header className="bg-white border-b border-slate-200">
      <div className="flex items-center gap-6 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
            <School className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Sara CRM</div>
            <div className="text-[11px] text-slate-500 leading-tight">Pequenos Guardiões</div>
          </div>
        </div>

        <nav className="flex items-center gap-1 ml-4">
          {tabs.map((t) => {
            const active = pathname.startsWith(t.href)
            const Icon = t.icon
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition ${
                  active ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon className="w-4 h-4" /> {t.label}
              </Link>
            )
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full bg-green-100 text-green-700 font-medium flex items-center gap-1.5">
            <Bot className="w-3 h-3" /> Sara IA ativa
          </span>
          <button
            onClick={signOut}
            className="text-slate-500 hover:text-slate-900 p-1.5 rounded-lg hover:bg-slate-100"
            title="Sair"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  )
}
FILE_EOF

echo 'Criando src/app/kanban/page.tsx'
cat > src/app/kanban/page.tsx << 'FILE_EOF'
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
FILE_EOF

echo 'Criando src/app/chat/page.tsx'
cat > src/app/chat/page.tsx << 'FILE_EOF'
'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import type { Lead, Mensagem } from '@/lib/types'
import { Bot, Send, Loader2, User } from 'lucide-react'

export default function ChatPage() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const [leads, setLeads] = useState<Lead[]>([])
  const [activeLead, setActiveLead] = useState<Lead | null>(null)
  const [mensagens, setMensagens] = useState<Mensagem[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const msgsRef = useRef<HTMLDivElement>(null)

  async function loadLeads() {
    const { data } = await supabase
      .from('leads')
      .select('*, familia:familias(*), crianca:criancas(*)')
      .order('atualizado_em', { ascending: false })
    if (data) {
      setLeads(data as Lead[])
      const want = searchParams.get('lead')
      const initial = want ? data.find((l: Lead) => l.id === want) : data[0]
      if (initial) setActiveLead(initial as Lead)
    }
  }

  async function loadMensagens(leadId: string) {
    const { data } = await supabase
      .from('mensagens')
      .select('*')
      .eq('lead_id', leadId)
      .order('criado_em')
    if (data) setMensagens(data as Mensagem[])
  }

  useEffect(() => { loadLeads() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  useEffect(() => {
    if (!activeLead) return
    loadMensagens(activeLead.id)

    const ch = supabase
      .channel(`msg-${activeLead.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensagens', filter: `lead_id=eq.${activeLead.id}` }, (payload) => {
        setMensagens((prev) => [...prev, payload.new as Mensagem])
      })
      .subscribe()

    return () => { supabase.removeChannel(ch) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLead])

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: 'smooth' })
  }, [mensagens])

  async function toggleIA(on: boolean) {
    if (!activeLead) return
    await supabase.from('leads').update({ ia_ativa: on }).eq('id', activeLead.id)
    setActiveLead({ ...activeLead, ia_ativa: on })
  }

  async function enviar() {
    if (!draft.trim() || !activeLead || sending) return
    setSending(true)
    const texto = draft
    setDraft('')

    const res = await fetch('/api/mensagens/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: activeLead.id, texto }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      alert('Erro ao enviar: ' + (err.error || res.statusText))
    }
    setSending(false)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Topbar />

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-[260px] border-r border-slate-200 bg-white overflow-y-auto">
          {leads.length === 0 && (
            <div className="p-6 text-center text-xs text-slate-400">Nenhum lead ainda. Quando alguém mandar mensagem no WhatsApp, aparece aqui.</div>
          )}
          {leads.map((l) => {
            const active = activeLead?.id === l.id
            return (
              <button
                key={l.id}
                onClick={() => setActiveLead(l)}
                className={`w-full text-left p-3 border-b border-slate-100 hover:bg-slate-50 transition ${active ? 'bg-blue-50' : ''}`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium truncate flex-1">{l.familia?.nome_responsavel || 'Sem nome'}</span>
                  {l.ia_ativa && <Bot className="w-3 h-3 text-green-600" />}
                </div>
                <div className="text-xs text-slate-500 truncate">{l.familia?.telefone}</div>
              </button>
            )
          })}
        </aside>

        <main className="flex-1 flex flex-col bg-white">
          {!activeLead ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
              Selecione uma conversa
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center">
                  <User className="w-4 h-4 text-slate-500" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium">{activeLead.familia?.nome_responsavel}</div>
                  <div className="text-xs text-slate-500">{activeLead.familia?.telefone} · Score {activeLead.score}</div>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <Bot className="w-4 h-4 text-slate-500" />
                  <span className="text-slate-600">Sara IA</span>
                  <input
                    type="checkbox"
                    checked={activeLead.ia_ativa}
                    onChange={(e) => toggleIA(e.target.checked)}
                    className="h-4 w-8 appearance-none rounded-full bg-slate-300 checked:bg-green-500 relative cursor-pointer transition before:content-[''] before:absolute before:top-0.5 before:left-0.5 before:w-3 before:h-3 before:bg-white before:rounded-full before:transition checked:before:translate-x-4"
                  />
                  <span className={`text-xs font-medium ${activeLead.ia_ativa ? 'text-green-600' : 'text-slate-400'}`}>
                    {activeLead.ia_ativa ? 'ativa' : 'inativa'}
                  </span>
                </label>
              </div>

              <div ref={msgsRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-slate-50">
                {mensagens.map((m) => {
                  const isIn = m.direcao === 'in'
                  const isIA = m.direcao === 'out_ia'
                  return (
                    <div key={m.id} className={`flex ${isIn ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[70%] px-3 py-2 rounded-2xl text-sm ${isIn ? 'bg-white border border-slate-200 rounded-bl-md' : isIA ? 'bg-green-100 text-green-900 rounded-br-md' : 'bg-blue-100 text-blue-900 rounded-br-md'}`}>
                        {m.conteudo}
                        <div className={`text-[10px] mt-1 ${isIn ? 'text-slate-400' : isIA ? 'text-green-700/70' : 'text-blue-700/70'}`}>
                          {isIA ? 'Sara IA' : isIn ? 'Família' : 'Equipe'} · {new Date(m.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {mensagens.length === 0 && <div className="text-center text-xs text-slate-400 py-8">Sem mensagens ainda</div>}
              </div>

              <div className="p-3 border-t border-slate-200 flex gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') enviar() }}
                  placeholder="Mensagem..."
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:border-blue-500"
                />
                <button
                  onClick={enviar}
                  disabled={sending || !draft.trim()}
                  className="px-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 text-sm font-medium"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
FILE_EOF

echo 'Criando src/app/api/mensagens/enviar/route.ts'
cat > src/app/api/mensagens/enviar/route.ts << 'FILE_EOF'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { evolutionSendText } from '@/lib/evolution'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const { lead_id, texto } = await req.json()
  if (!lead_id || !texto) return NextResponse.json({ error: 'lead_id e texto obrigatórios' }, { status: 400 })

  // Pega telefone do lead
  const { data: lead } = await supabase
    .from('leads')
    .select('familia:familias(telefone)')
    .eq('id', lead_id)
    .single<{ familia: { telefone: string } }>()

  if (!lead?.familia?.telefone) return NextResponse.json({ error: 'Lead sem telefone' }, { status: 400 })

  try {
    const result = await evolutionSendText(lead.familia.telefone, texto)
    const wid = result?.key?.id || null

    // Salva mensagem
    await supabase.from('mensagens').insert({
      lead_id,
      direcao: 'out_humano',
      conteudo: texto,
      enviado_por: user.id,
      whatsapp_message_id: wid,
    })

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
FILE_EOF

echo 'Criando src/app/api/webhook/whatsapp/route.ts'
cat > src/app/api/webhook/whatsapp/route.ts << 'FILE_EOF'
import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { cleanWhatsappJid, evolutionSendText } from '@/lib/evolution'
import { gerarRespostaSara } from '@/lib/sara'

// GET para verificar que o webhook está vivo
export async function GET() {
  return NextResponse.json({ ok: true, msg: 'Webhook escola-crm online' })
}

// POST recebe eventos da Evolution
export async function POST(req: NextRequest) {
  const supabase = createServerAdminClient()

  try {
    const body = await req.json()

    // Estrutura do evento Evolution: { event, instance, data }
    const event = body.event
    const data = body.data

    // Só processamos mensagens recebidas
    if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT') {
      return NextResponse.json({ ignored: event })
    }

    // Ignora mensagens enviadas pela própria escola (fromMe)
    if (data?.key?.fromMe === true) return NextResponse.json({ ignored: 'fromMe' })

    const jid: string = data?.key?.remoteJid || ''
    if (!jid || jid.includes('@g.us')) return NextResponse.json({ ignored: 'group ou sem jid' })

    const telefone = cleanWhatsappJid(jid)
    const conteudo: string =
      data?.message?.conversation ||
      data?.message?.extendedTextMessage?.text ||
      data?.message?.imageMessage?.caption ||
      '[mídia ou tipo não suportado ainda]'

    const pushName: string = data?.pushName || 'Família'
    const wid: string = data?.key?.id || ''

    // 1. Garante família
    let { data: familia } = await supabase
      .from('familias')
      .select('id, nome_responsavel')
      .eq('telefone', telefone)
      .maybeSingle()

    if (!familia) {
      const ins = await supabase
        .from('familias')
        .insert({ nome_responsavel: pushName, telefone, origem: 'whatsapp' })
        .select('id, nome_responsavel')
        .single()
      familia = ins.data
    }
    if (!familia) throw new Error('Falha ao criar família')

    // 2. Garante lead na primeira coluna ('Capturados')
    let { data: lead } = await supabase
      .from('leads')
      .select('id, ia_ativa, coluna_id')
      .eq('familia_id', familia.id)
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!lead) {
      const { data: primeiraColuna } = await supabase
        .from('colunas')
        .select('id, ia_ativa_default')
        .order('ordem')
        .limit(1)
        .single()

      const ins = await supabase
        .from('leads')
        .insert({
          familia_id: familia.id,
          coluna_id: primeiraColuna!.id,
          ia_ativa: primeiraColuna!.ia_ativa_default,
          tags: ['whatsapp'],
        })
        .select('id, ia_ativa, coluna_id')
        .single()
      lead = ins.data
    }
    if (!lead) throw new Error('Falha ao criar lead')

    // 3. Salva mensagem recebida
    await supabase.from('mensagens').insert({
      lead_id: lead.id,
      direcao: 'in',
      conteudo,
      whatsapp_message_id: wid,
    })

    // 4. Se IA ativa, gera resposta e envia
    if (lead.ia_ativa) {
      try {
        const resposta = await gerarRespostaSara(lead.id)
        const sent = await evolutionSendText(telefone, resposta)

        await supabase.from('mensagens').insert({
          lead_id: lead.id,
          direcao: 'out_ia',
          conteudo: resposta,
          whatsapp_message_id: sent?.key?.id || null,
        })
      } catch (e) {
        console.error('Sara IA falhou:', e)
        // Não derruba o webhook por causa da IA
      }
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    console.error('Webhook error:', e)
    const msg = e instanceof Error ? e.message : 'Erro desconhecido'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
FILE_EOF

echo ""
echo "✅ Todos os arquivos criados!"
echo "Próximo: edite .env.local com suas chaves, depois rode: npm run dev"
