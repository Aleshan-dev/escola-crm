// Pacing anti-bloqueio do WhatsApp: evita rajadas de envio que disparam
// o bloqueio preventivo. Ver docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md.

// Máximo de mensagens automáticas por execução do cron (a cada 20 min).
// Mantido baixo para caber no tempo de execução da função e não formar rajada.
export const MAX_ENVIOS_POR_EXECUCAO = 6

// Disparo em massa do Salomão (boletos + comunicados): teto por execução do
// cron /api/cron/salomao-dispatch. Diferente da Sara, o Salomão fala com pais
// MATRICULADOS (público quente, menor risco), mas o volume é maior — a escola
// inteira de uma vez. O anti-rajada aqui é o gargalo: teto baixo + espaçamento
// largo (15–45s). Com 6 envios × 45s ≈ 270s, cabe no maxDuration de 300s.
// A escola inteira sai em várias levas, ao longo da janela comercial, sem
// formar bloco. Ver docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md.
export const MAX_ENVIOS_SALOMAO_POR_EXECUCAO = 6

// Espaçamento entre contatos no disparo em massa do Salomão (ms). Bem mais
// largo que o da Sara (0,8–2s): comunicado/boleto para muita gente de uma vez
// é o padrão que mais parece spam, então cada contato fica a 15–45s do próximo.
export const SALOMAO_JITTER_MIN_MS = 15_000
export const SALOMAO_JITTER_MAX_MS = 45_000

// Intervalo aleatório (ms) entre um envio e o próximo, para parecer humano.
export function jitterMs(minMs = 800, maxMs = 2000): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs))
}

export const sleep = (msVal: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, msVal))
