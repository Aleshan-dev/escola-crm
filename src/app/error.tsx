'use client'

// Error boundary de rota (App Router). Captura erros de render/efeito nas páginas
// abaixo do layout raiz e evita a tela branca. Item 6 do backlog de melhorias
// (gabarito DeskcommCRM). Quando o Sentry entrar (item 2), chamar captureException
// dentro do useEffect abaixo.

import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Observabilidade mínima até o Sentry entrar (item 2 do backlog).
    console.error('[error-boundary]', error)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      <div className="max-w-md w-full text-center">
        <div className="text-4xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold mb-2">Algo saiu do lugar</h1>
        <p className="text-slate-600 mb-6">
          A tela encontrou um erro inesperado. Você pode tentar de novo — seus dados estão a salvo.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
          >
            Tentar de novo
          </button>
          <a
            href="/inicio"
            className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:bg-slate-100 transition-colors"
          >
            Ir para o início
          </a>
        </div>
        {error.digest && (
          <p className="mt-6 text-xs text-slate-400 font-mono">ref: {error.digest}</p>
        )}
      </div>
    </div>
  )
}
