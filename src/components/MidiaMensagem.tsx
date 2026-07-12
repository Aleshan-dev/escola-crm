'use client'

import { Paperclip, PlayCircle } from 'lucide-react'

// Renderiza a mídia de uma mensagem (arquivo salvo no bucket privado).
// A URL passa pela rota autenticada /api/midia, que assina o acesso.
export function MidiaMensagem({ tipo, path }: { tipo: string; path: string }) {
  const src = `/api/midia?path=${encodeURIComponent(path)}`

  if (tipo === 'imagem') {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="Imagem enviada" className="rounded-lg max-w-[220px] max-h-[240px] object-cover" />
      </a>
    )
  }

  if (tipo === 'audio') {
    return <audio controls src={src} className="max-w-[240px]" />
  }

  if (tipo === 'video') {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium underline">
        <PlayCircle className="w-4 h-4" /> Abrir vídeo
      </a>
    )
  }

  // documento e outros
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium underline">
      <Paperclip className="w-4 h-4" /> Abrir arquivo
    </a>
  )
}
