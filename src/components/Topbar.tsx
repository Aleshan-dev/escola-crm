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
