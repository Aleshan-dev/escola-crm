import { describe, it, expect } from 'vitest'
import { detectarOrigem, normalizarFrase, extrairReferralWaha, type ConfigAnuncio } from './atribuicao'

const cfg: ConfigAnuncio = {
  frases: [
    { texto: normalizarFrase('Oi! Vim pelo Instagram e quero saber das matrículas 2027'), campanha: null },
    { texto: normalizarFrase('Quero conhecer o Berçário'), campanha: 'criativo-bercario' },
  ],
  campanhaPadrao: 'instagram-matriculas-2027',
}

describe('atribuicao — detectarOrigem por frase do anúncio', () => {
  it('casa ignorando acento, emoji, caixa e pontuação → meta-ads + campanha padrão', () => {
    const r = detectarOrigem({ texto: 'oi vim pelo instagram e quero saber das matriculas 2027', cfg })
    expect(r.canal).toBe('meta-ads')
    expect(r.campanha).toBe('instagram-matriculas-2027')
  })

  it('casa mesmo com texto extra antes/depois (lead digita algo a mais)', () => {
    const r = detectarOrigem({ texto: 'Olá, tudo bem? Oi! Vim pelo Instagram e quero saber das matrículas 2027 😊', cfg })
    expect(r.canal).toBe('meta-ads')
  })

  it('linha "frase => campanha" carimba a campanha do criativo', () => {
    const r = detectarOrigem({ texto: 'quero conhecer o berçário', cfg })
    expect(r.canal).toBe('meta-ads')
    expect(r.campanha).toBe('criativo-bercario')
  })

  it('mensagem orgânica comum fica organico', () => {
    const r = detectarOrigem({ texto: 'Bom dia, vocês têm vaga para maternal?', cfg })
    expect(r.canal).toBe('organico')
    expect(r.campanha).toBeNull()
  })

  it('saudação curta não casa (guarda contra falso-positivo)', () => {
    expect(detectarOrigem({ texto: 'oi', cfg }).canal).toBe('organico')
    expect(detectarOrigem({ texto: 'bom dia', cfg }).canal).toBe('organico')
  })

  it('sem frases configuradas e sem referral → organico (comportamento atual)', () => {
    const vazio: ConfigAnuncio = { frases: [], campanhaPadrao: null }
    expect(detectarOrigem({ texto: 'Oi! Vim pelo Instagram', cfg: vazio }).canal).toBe('organico')
  })
})

describe('atribuicao — referral CTWA nativo (bônus quando o engine entrega)', () => {
  it('referral com title vence e vira campanha', () => {
    const r = detectarOrigem({ texto: 'qualquer coisa', referral: { title: 'Matrículas Abertas 2027', sourceId: '123' }, cfg })
    expect(r.canal).toBe('meta-ads')
    expect(r.campanha).toBe('Matrículas Abertas 2027')
  })

  it('extrairReferralWaha acha externalAdReply em _data.message.extendedTextMessage.contextInfo', () => {
    const p = { _data: { message: { extendedTextMessage: { contextInfo: { externalAdReply: { title: 'Anúncio X' } } } } } }
    expect(extrairReferralWaha(p)).toEqual({ title: 'Anúncio X' })
  })

  it('extrairReferralWaha devolve null quando não há anúncio', () => {
    expect(extrairReferralWaha({ _data: { message: { conversation: 'oi' } } })).toBeNull()
    expect(extrairReferralWaha(null)).toBeNull()
  })
})
