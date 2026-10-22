import { Check, CheckCheck, AlertCircle } from 'lucide-react'
import type { Mensagem } from '@/lib/types'

// Recibo de entrega no rodapé do balão (estilo WhatsApp), só para mensagens de saída:
//   enviado  → ✓  (cinza)
//   entregue → ✓✓ (cinza)
//   lido     → ✓✓ (azul)
//   falhou   → ⚠  (vermelho, com o motivo no hover)
export function MensagemStatus({ status, erro_envio }: Pick<Mensagem, 'status' | 'erro_envio'>) {
  if (status === 'falhou') {
    return (
      <span title={erro_envio || 'Falha no envio'} className="inline-flex">
        <AlertCircle className="w-3 h-3 text-red-500" />
      </span>
    )
  }
  if (status === 'lido') {
    return (
      <span title="Lida" className="inline-flex">
        <CheckCheck className="w-3.5 h-3.5 text-sky-500" />
      </span>
    )
  }
  if (status === 'entregue') {
    return (
      <span title="Entregue" className="inline-flex">
        <CheckCheck className="w-3.5 h-3.5 text-current opacity-70" />
      </span>
    )
  }
  // enviado (default)
  return (
    <span title="Enviada" className="inline-flex">
      <Check className="w-3 h-3 text-current opacity-70" />
    </span>
  )
}
