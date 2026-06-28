'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { Home, Filter, CalendarDays, Users, MessageSquare, Settings, LogOut, type LucideIcon } from 'lucide-react'

const NAV: { href: string; icon: LucideIcon; label: string }[] = [
  { href: '/inicio', icon: Home, label: 'Início' },
  { href: '/kanban', icon: Filter, label: 'Funil' },
  { href: '/agendamentos', icon: CalendarDays, label: 'Agenda' },
  { href: '/responsaveis', icon: Users, label: 'Responsáveis' },
  { href: '/chat', icon: MessageSquare, label: 'Conversas' },
  { href: '/configuracoes', icon: Settings, label: 'Configurações' },
]

export function Topbar() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const [iniciais, setIniciais] = useState('')

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser()
      const base = (data?.user?.email || '').split('@')[0] || ''
      setIniciais(base.slice(0, 2).toUpperCase())
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function sair() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-16 flex-col items-center bg-[#1A237E] py-4 text-white">
      <Link href="/inicio" className="mb-6 flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-sm font-bold">PG</Link>
      <nav className="flex flex-1 flex-col items-center gap-1">
        {NAV.map((n) => {
          const ativo = pathname === n.href || pathname.startsWith(n.href + '/')
          const Icon = n.icon
          return (
            <Link key={n.href} href={n.href} title={n.label}
              className={`flex h-11 w-11 items-center justify-center rounded-xl transition ${ativo ? 'bg-white/20' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}>
              <Icon className="h-5 w-5" />
            </Link>
          )
        })}
      </nav>
      <div className="mt-4 flex flex-col items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">{iniciais || '··'}</div>
        <button onClick={sair} title="Sair" className="flex h-9 w-9 items-center justify-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </aside>
  )
}
