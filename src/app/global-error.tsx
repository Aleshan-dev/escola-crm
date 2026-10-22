'use client'

// Error boundary de ÚLTIMO recurso: captura falhas no próprio layout raiz, onde o
// error.tsx normal não alcança. Precisa renderizar suas próprias tags <html>/<body>
// porque substitui o layout raiz. Item 6 do backlog (gabarito DeskcommCRM).

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[global-error]', error)
  }, [error])

  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f8fafc', color: '#0f172a' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🛠️</div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>O sistema encontrou uma falha</h1>
            <p style={{ color: '#475569', margin: '0 0 24px', lineHeight: 1.5 }}>
              Recarregue a página. Se persistir, avise a equipe técnica.
            </p>
            <button
              onClick={reset}
              style={{ padding: '8px 16px', borderRadius: 8, background: '#0f172a', color: '#fff', border: 'none', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}
            >
              Recarregar
            </button>
            {error.digest && (
              <p style={{ marginTop: 24, fontSize: 12, color: '#94a3b8', fontFamily: 'monospace' }}>ref: {error.digest}</p>
            )}
          </div>
        </div>
      </body>
    </html>
  )
}
