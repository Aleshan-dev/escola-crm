// Pacing anti-bloqueio do WhatsApp: evita rajadas de envio que disparam
// o bloqueio preventivo. Ver docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md.

// Máximo de mensagens automáticas por execução do cron (a cada 20 min).
// Mantido baixo para caber no tempo de execução da função e não formar rajada.
export const MAX_ENVIOS_POR_EXECUCAO = 6

// Intervalo aleatório (ms) entre um envio e o próximo, para parecer humano.
export function jitterMs(minMs = 800, maxMs = 2000): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs))
}

export const sleep = (msVal: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, msVal))
