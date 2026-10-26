import { describe, it, expect } from 'vitest'
import {
  MAX_CORPO, MAX_POR_TURNO, MAX_TITULO, blocoMemoria, contemDadoSensivel, custoTotal, indexarNotas,
  normalizarTitulo, parseMemoriaSalvar, validarNota, type NotaMemoria,
} from './regras'

const nota = (id: string, titulo: string, corpo: string, criado_em: string): NotaMemoria => ({
  id, titulo, corpo, origem: 'sara', criado_em, atualizado_em: criado_em,
})

describe('memoria — normalizarTitulo', () => {
  it('ignora caixa, acento, pontuação e espaços (igual ao SQL)', () => {
    expect(normalizarTitulo('  Alérgia   Alimentar! ')).toBe('alergia alimentar')
    expect(normalizarTitulo('Horário da mãe')).toBe(normalizarTitulo('horario da mae'))
    expect(normalizarTitulo('!!!')).toBe('')
  })
})

describe('memoria — validarNota', () => {
  it('aceita e corta excessos', () => {
    const v = validarNota({ titulo: 'x'.repeat(200), corpo: 'y'.repeat(900) })
    expect(v?.titulo.length).toBe(MAX_TITULO)
    expect(v?.corpo.length).toBe(MAX_CORPO)
  })
  it('rejeita título vazio, não-objeto e dado sensível', () => {
    expect(validarNota({ titulo: '  ', corpo: 'a' })).toBeNull()
    expect(validarNota('texto')).toBeNull()
    expect(validarNota({ titulo: 'CPF da mãe', corpo: '123.456.789-09' })).toBeNull()
    expect(validarNota({ titulo: 'Cartão', corpo: '4111 1111 1111 1111' })).toBeNull()
    expect(validarNota({ titulo: 'Pix', corpo: '00020126br.gov.bcb.pix0136' })).toBeNull()
  })
  it('não confunde data ou telefone curto com dado sensível', () => {
    expect(contemDadoSensivel('visita em 30/10/2026 às 14h')).toBe(false)
    expect(contemDadoSensivel('3 primeiros dígitos 123')).toBe(false)
  })
})

describe('memoria — indexarNotas / blocoMemoria', () => {
  const notas = [
    nota('u2', 'Horário da mãe', 'trabalha até 18h', '2026-10-20T10:00:00Z'),
    nota('u1', 'Alergia', 'lactose', '2026-10-01T10:00:00Z'),
  ]
  it('numera da mais antiga para a mais nova', () => {
    const { linhas, mapa } = indexarNotas(notas)
    expect(linhas.map((l) => l.codigo + l.nota.id)).toEqual(['M1u1', 'M2u2'])
    expect(mapa).toEqual({ M1: 'u1', M2: 'u2' })
  })
  it('mostra título, corpo e código; nunca o uuid', () => {
    const b = blocoMemoria(notas)
    expect(b).toContain('[M1] Alergia: lactose (01/10/2026)')
    expect(b).toContain('[M2] Horário da mãe')
    expect(b).not.toContain('u1')
  })
  it('sem notas diz que não há; quase cheia pede consolidação', () => {
    expect(blocoMemoria([])).toContain('nenhuma memória registrada')
    expect(blocoMemoria([])).not.toContain('ATENÇÃO')
    expect(blocoMemoria(notas, custoTotal(notas))).toContain('CONSOLIDE')
  })
})

describe('memoria — parseMemoriaSalvar', () => {
  const mapa = { M1: 'u1', M2: 'u2' }
  it('traduz M# para uuid e descarta códigos inexistentes', () => {
    const r = parseMemoriaSalvar([{ titulo: 'Rotina', corpo: 'a', substitui: ['M2', 'm1', 'M9', 7, 'M2'] }], mapa)
    expect(r).toEqual([{ titulo: 'Rotina', corpo: 'a', substitui: ['u2', 'u1'] }])
  })
  it('não é array → nada; itens inválidos e títulos repetidos caem', () => {
    expect(parseMemoriaSalvar(null, mapa)).toEqual([])
    expect(parseMemoriaSalvar({ titulo: 'x' }, mapa)).toEqual([])
    const r = parseMemoriaSalvar([{ titulo: 'Alergia', corpo: 'a' }, { titulo: 'alérgia', corpo: 'b' }, { corpo: 'sem título' }], mapa)
    expect(r).toHaveLength(1)
  })
  it('limita por turno e ignora campos extras', () => {
    const muitos = Array.from({ length: 6 }, (_, i) => ({ titulo: `Fato ${i}`, corpo: '', lead_id: 'outro', id: 'x' }))
    const r = parseMemoriaSalvar(muitos, mapa)
    expect(r).toHaveLength(MAX_POR_TURNO)
    expect(Object.keys(r[0]).sort()).toEqual(['corpo', 'substitui', 'titulo'])
  })
})
