import { describe, expect, it } from 'vitest'
import { canalDaConversa, escolherCanal, refDoCanal } from './politica'
import type { EstadoCanais, Operacao } from './tipos'

const estado = (over: Partial<EstadoCanais> = {}): EstadoCanais => ({
  cloud: null,
  wahaConfigurado: true,
  evolutionConfigurado: true,
  canalDisparo: 'waha',
  wahaSessao: 'org_1',
  evolutionInstancia: 'inst',
  ...over,
})
const cloudAtiva = { phoneNumberId: 'pn1', token: 't' }

describe('canalDaConversa', () => {
  it('usa o canal carimbado na família', () => {
    expect(canalDaConversa('waha', estado({ cloud: cloudAtiva }))).toBe('waha')
    expect(canalDaConversa('evolution', estado())).toBe('evolution')
  })

  it('sem carimbo: Cloud se houver conta ativa, senão o canal de disparos', () => {
    expect(canalDaConversa(null, estado({ cloud: cloudAtiva }))).toBe('cloud')
    expect(canalDaConversa(null, estado({ canalDisparo: 'evolution' }))).toBe('evolution')
    expect(canalDaConversa('lixo', estado())).toBe('waha')
  })
})

describe('escolherCanal — sem fallback entre números', () => {
  const conversa: Operacao[] = ['resposta', 'followup', 'manual', 'aviso_interno']

  it.each(conversa)('%s: conversa no WAHA com WAHA fora NÃO cai na Cloud nem no Evolution', (op) => {
    const e = escolherCanal(op, 'waha', estado({ wahaConfigurado: false, cloud: cloudAtiva }))
    expect(e).toEqual({ ok: false, canal: 'waha', motivo: 'WAHA não configurado' })
  })

  it.each(conversa)('%s: conversa na Cloud sem conta ativa NÃO cai no canal de disparos', (op) => {
    const e = escolherCanal(op, 'cloud', estado())
    expect(e.ok).toBe(false)
    expect(e.canal).toBe('cloud')
  })

  it.each(conversa)('%s: conversa no Evolution sai pelo Evolution mesmo com a flag em WAHA', (op) => {
    expect(escolherCanal(op, 'evolution', estado({ canalDisparo: 'waha' }))).toEqual({ ok: true, canal: 'evolution' })
  })

  it('campanha usa o canal de disparos, não o da conversa', () => {
    expect(escolherCanal('campanha', 'cloud', estado({ cloud: cloudAtiva, canalDisparo: 'waha' }))).toEqual({ ok: true, canal: 'waha' })
  })

  it('campanha com o canal de disparos fora falha (não procura outro)', () => {
    const e = escolherCanal('campanha', null, estado({ canalDisparo: 'evolution', evolutionConfigurado: false }))
    expect(e).toEqual({ ok: false, canal: 'evolution', motivo: 'Evolution não configurado' })
  })
})

describe('refDoCanal', () => {
  it('devolve a conexão do provedor', () => {
    const e = estado({ cloud: cloudAtiva })
    expect(refDoCanal('waha', e)).toBe('org_1')
    expect(refDoCanal('cloud', e)).toBe('pn1')
    expect(refDoCanal('evolution', e)).toBe('inst')
  })
})
