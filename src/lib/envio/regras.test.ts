import { describe, expect, it } from 'vitest'
import { DEFAULTS, type ConfigCanal } from './defaults'
import {
  avaliarJanela, avaliarRepeticao, dentroDaJanela, horaEDiaLocal, idadeDoNumeroDias,
  intervaloComJitter, isentoDeRepeticao, normalizar, similaridadeJaccard, tetoAquecimento, tetoDoDia,
} from './regras'

const cfg = (o: Partial<ConfigCanal> = {}): ConfigCanal => ({ ...DEFAULTS, ...o })
// Acre = UTC-5. 2026-10-21 é quarta; 2026-10-25 é domingo.
const acre = (iso: string) => Date.parse(`${iso}-05:00`)

describe('janela', () => {
  it('lê hora e dia no fuso do canal', () => {
    expect(horaEDiaLocal(acre('2026-10-21T09:30:00'), 'America/Rio_Branco')).toEqual({ hora: 9, dia: 3 })
  })

  it('[ini, fim) e janela que vira a meia-noite', () => {
    expect(dentroDaJanela(8, 8, 20)).toBe(true)
    expect(dentroDaJanela(20, 8, 20)).toBe(false)
    expect(dentroDaJanela(23, 20, 6)).toBe(true)
    expect(dentroDaJanela(7, 20, 6)).toBe(false)
    expect(dentroDaJanela(3, 0, 24)).toBe(true)
  })

  it('proativa usa a janela de disparo; resposta usa a de resposta (24h por padrão)', () => {
    const noite = acre('2026-10-21T22:00:00')
    expect(avaliarJanela(cfg(), 'followup', noite)).toEqual({ ok: false, motivo: 'fora_da_janela' })
    expect(avaliarJanela(cfg(), 'resposta_ia', noite)).toEqual({ ok: true })
    expect(avaliarJanela(cfg(), 'followup', acre('2026-10-21T10:00:00'))).toEqual({ ok: true })
  })

  it('domingo desligado barra só o disparo; manual nunca é barrado', () => {
    const dom = acre('2026-10-25T10:00:00')
    const c = cfg({ domingoDisparo: false })
    expect(avaliarJanela(c, 'salomao', dom)).toEqual({ ok: false, motivo: 'domingo' })
    expect(avaliarJanela(c, 'resposta_ia', dom)).toEqual({ ok: true })
    expect(avaliarJanela(c, 'manual', acre('2026-10-21T23:00:00'))).toEqual({ ok: true })
  })
})

describe('aquecimento e teto do dia', () => {
  const hoje = acre('2026-10-21T10:00:00')

  it('idade do número; sem data = 0', () => {
    expect(idadeDoNumeroDias(null, hoje)).toBe(0)
    expect(idadeDoNumeroDias('2026-10-11', hoje)).toBe(10)
    expect(idadeDoNumeroDias('lixo', hoje)).toBe(0)
  })

  it('degraus 20/50/100/200 e sem teto depois de 30 dias', () => {
    expect(tetoAquecimento(0)).toBe(20)
    expect(tetoAquecimento(3)).toBe(20)
    expect(tetoAquecimento(4)).toBe(50)
    expect(tetoAquecimento(14)).toBe(100)
    expect(tetoAquecimento(30)).toBe(200)
    expect(tetoAquecimento(31)).toBeNull()
  })

  it('vale o MENOR entre aquecimento e teto diário', () => {
    expect(tetoDoDia('waha', cfg({ numeroDesde: '2026-10-11' }), hoje)).toBe(100)
    expect(tetoDoDia('waha', cfg({ numeroDesde: '2026-10-11', tetoDiario: 60 }), hoje)).toBe(60)
    expect(tetoDoDia('waha', cfg({ numeroDesde: '2025-01-01' }), hoje)).toBeNull()
    expect(tetoDoDia('waha', cfg({ numeroDesde: '2025-01-01', tetoDiario: 300 }), hoje)).toBe(300)
  })

  it('pular aquecimento deixa só o teto diário', () => {
    expect(tetoDoDia('evolution', cfg({ pularAquecimento: true }), hoje)).toBeNull()
    expect(tetoDoDia('evolution', cfg({ pularAquecimento: true, tetoDiario: 80 }), hoje)).toBe(80)
  })

  it('Cloud oficial não tem teto nem intervalo locais', () => {
    expect(tetoDoDia('cloud', cfg({ tetoDiario: 5 }), hoje)).toBeNull()
    expect(intervaloComJitter('cloud', cfg(), 0.5)).toBe(0)
    expect(intervaloComJitter('waha', cfg(), 0.5)).toBe(1200 + 400)
  })
})

describe('repetição', () => {
  it('normaliza caixa e espaços, mantém pontuação', () => {
    expect(normalizar('  Olá,   Tudo\nBem? ')).toBe('olá, tudo bem?')
  })

  it('Jaccard de palavras', () => {
    expect(similaridadeJaccard('a b c d', 'a b c d')).toBe(1)
    expect(similaridadeJaccard('a b c d', 'a b c e')).toBeCloseTo(3 / 5)
  })

  it('isenta texto curto e cobrança/pagamento', () => {
    expect(isentoDeRepeticao('ok, combinado')).toBe(true)
    expect(isentoDeRepeticao('Segue o seu boleto de outubro, qualquer dúvida estou aqui')).toBe(true)
    expect(isentoDeRepeticao('Segue a chave PIX para pagamento da matrícula')).toBe(true)
    expect(isentoDeRepeticao('Oi! Vi que você se interessou pela escola, posso ajudar?')).toBe(false)
  })

  it('veta a partir da 3ª cópia parecida (2 ocorrências na janela)', () => {
    const t = 'Oi! Vi que você se interessou pela escola, posso ajudar?'
    const n = normalizar(t)
    expect(avaliarRepeticao(t, [n]).repetido).toBe(false)
    expect(avaliarRepeticao(t, [n, n])).toEqual({ repetido: true, ocorrencias: 2 })
    expect(avaliarRepeticao(t, [normalizar('Bom dia, a visita está confirmada para amanhã às 9h'), n]).repetido).toBe(false)
  })
})
