'use client'

import { createClient } from '@/lib/supabase-browser'

// Conta logada que não é da equipe do CRM (família do app, professora, sem
// acesso). O middleware manda para cá; a RLS do banco já barra os dados.
export default function SemAcesso() {
  const sair = async () => {
    await createClient().auth.signOut()
    window.location.href = '/login'
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      <div className="max-w-md w-full text-center">
        <div className="text-4xl mb-4">🔒</div>
        <h1 className="text-xl font-semibold mb-2">Acesso restrito à equipe</h1>
        <p className="text-slate-600 mb-6">
          Esta conta não tem acesso ao CRM. Se você trabalha no comercial da escola, peça à Direção
          para liberar o papel Comercial no ARCA.
        </p>
        <button
          onClick={sair}
          className="inline-block px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
        >
          Sair
        </button>
      </div>
    </div>
  )
}
