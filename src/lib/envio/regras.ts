// Regras PURAS da proteção de envio: sem banco, sem rede, sem relógio global
// (o instante entra como parâmetro). Testadas em regras.test.ts.

import {
  AQUECIMENTO, BAN_RISK, ORIGEM_PROATIVA, REPETICAO,
  type Canal, type ConfigCanal, type OrigemEnvio,
} from './defaults'

/** Hora (0–23) e dia da semana (0 = domingo) no fuso do canal. */
export function horaEDiaLocal(nowMs: number, fuso: string): { hora: number; dia: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso, hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(nowMs))
  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? 0)
  const wd = partes.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const dia = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
  return { hora, dia }
}

/**
 * O canal pode falar agora com esta origem? Origem proativa usa a janela de
 * DISPARO (e respeita o domingo); resposta/manual usam a janela de RESPOSTA.
 * Envio manual nunca é barrado por janela: a pessoa decide.
 */
export function avaliarJanela(
  cfg: ConfigCanal, origem: OrigemEnvio, nowMs: number,
): { ok: true } | { ok: false; motivo: 'fora_da_janela' | 'domingo' } {
  if (origem === 'manual' || origem === 'aviso_interno') return { ok: true }
  const { hora, dia } = horaEDiaLocal(nowMs, cfg.fuso)
  const proativa = ORIGEM_PROATIVA[origem]
  if (proativa && dia === 0 && !cfg.domingoDisparo) return { ok: false, motivo: 'domingo' }
  const [ini, fim] = proativa ? cfg.janelaDisparo : cfg.janelaResposta
  return dentroDaJanela(hora, ini, fim) ? { ok: true } : { ok: false, motivo: 'fora_da_janela' }
}

/** [ini, fim) em horas; aceita janela que vira a meia-noite (ex.: 20–6). ini=fim ou 0–24 = sempre. */
export function dentroDaJanela(hora: number, ini: number, fim: number): boolean {
  if (ini === fim || (ini === 0 && fim === 24)) return true
  return ini < fim ? hora >= ini && hora < fim : hora >= ini || hora < fim
}

/** Dias desde a data declarada de uso do número. Sem data = 0 (degrau mais conservador). */
export function idadeDoNumeroDias(numeroDesde: string | null, nowMs: number): number {
  if (!numeroDesde) return 0
  const t = Date.parse(`${numeroDesde}T00:00:00Z`)
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000))
}

/** Teto do aquecimento para a idade, ou null (número maduro, sem teto de aquecimento). */
export function tetoAquecimento(idadeDias: number): number | null {
  for (const d of AQUECIMENTO) if (idadeDias <= d.ateDia) return d.teto
  return null
}

/**
 * Teto efetivo do dia: o MENOR entre o aquecimento e o teto diário configurado.
 * Canal sem risco de ban (Cloud) não tem teto local. null = sem teto.
 */
export function tetoDoDia(canal: Canal, cfg: ConfigCanal, nowMs: number): number | null {
  if (!BAN_RISK[canal]) return null
  const aquec = cfg.pularAquecimento ? null : tetoAquecimento(idadeDoNumeroDias(cfg.numeroDesde, nowMs))
  const vals = [aquec, cfg.tetoDiario].filter((v): v is number => v != null)
  return vals.length ? Math.min(...vals) : null
}

/** Intervalo a respeitar desde o último envio do canal (mínimo + jitter sorteado). */
export function intervaloComJitter(canal: Canal, cfg: ConfigCanal, rand: number): number {
  if (!BAN_RISK[canal]) return 0
  return cfg.intervaloMinMs + Math.floor(rand * cfg.jitterMaxMs)
}

/** Minúsculas, espaços colapsados. Pontuação e emoji ficam (mesma regra do Deskcomm). */
export function normalizar(texto: string): string {
  return texto.toLowerCase().replace(/\s+/g, ' ').trim()
}

function palavras(t: string): Set<string> {
  return new Set(t.split(' ').filter(Boolean))
}

/** Similaridade de Jaccard entre os conjuntos de palavras de dois textos já normalizados. */
export function similaridadeJaccard(a: string, b: string): number {
  if (a === b) return 1
  const A = palavras(a)
  const B = palavras(b)
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

/** Texto isento do gate de repetição: curto demais ou padrão de cobrança/pagamento. */
export function isentoDeRepeticao(texto: string): boolean {
  if (texto.trim().length < REPETICAO.minCaracteres) return true
  return REPETICAO.isentos.some((re) => re.test(texto))
}

/**
 * A candidata repete as saídas recentes do canal? Conta quantas das `recentes`
 * (já normalizadas) têm Jaccard ≥ limiar; veta a partir de `minOcorrencias` —
 * em regra, a 3ª cópia parecida é a barrada.
 */
export function avaliarRepeticao(
  texto: string, recentes: string[],
): { repetido: boolean; ocorrencias: number } {
  if (isentoDeRepeticao(texto)) return { repetido: false, ocorrencias: 0 }
  const n = normalizar(texto)
  let ocorrencias = 0
  for (const r of recentes.slice(0, REPETICAO.janela)) {
    if (r && similaridadeJaccard(n, r) >= REPETICAO.limiar) ocorrencias++
  }
  return { repetido: ocorrencias >= REPETICAO.minOcorrencias, ocorrencias }
}
