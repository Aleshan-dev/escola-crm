// Página 404 canônica (App Router). Item 6 do backlog de melhorias.

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-900 p-6">
      <div className="max-w-md w-full text-center">
        <div className="text-4xl mb-4">🧭</div>
        <h1 className="text-xl font-semibold mb-2">Página não encontrada</h1>
        <p className="text-slate-600 mb-6">
          O endereço que você abriu não existe ou foi movido.
        </p>
        <a
          href="/inicio"
          className="inline-block px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
        >
          Ir para o início
        </a>
      </div>
    </div>
  )
}
