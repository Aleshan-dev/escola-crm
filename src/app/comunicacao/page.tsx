'use client'

import { Topbar } from '@/components/Topbar'
import { FunilMatriculados } from '@/components/FunilMatriculados'

// Rota alternativa (deep-link) para o quadro de matriculados por turma.
// O acesso principal é pelo seletor de funil na tela /kanban.
export default function ComunicacaoPage() {
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="px-4 py-3 border-b border-slate-200 bg-white">
        <h1 className="text-lg font-semibold">Matriculados por turma</h1>
        <p className="text-xs text-slate-500">Famílias matriculadas, organizadas por turma (dados do SGEI — Escola Guardiã).</p>
      </div>
      <FunilMatriculados />
    </div>
  )
}
