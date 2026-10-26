import { describe, expect, it } from 'vitest'
import {
  aplicarPatch, diffLinhas, diffSnapshots, estadoEditor, normalizarSnapshot, snapshotDeConfig, snapshotsIguais,
} from './regras'

const UUID = '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b'

describe('normalizarSnapshot', () => {
  it('mantém só os campos do agente e tipa cada um', () => {
    const s = normalizarSnapshot('sara', {
      nome_agente: '  Sara ', modelo: 'gpt-4o', informa_preco: 'sim', system_prompt: '  regra\n', sara_credencial_id: UUID.toUpperCase(),
      salomao_modelo: 'x', followup_ativo: true,
    })
    expect(s).toEqual({ nome_agente: 'Sara', modelo: 'gpt-4o', informa_preco: false, system_prompt: '  regra\n', sara_credencial_id: UUID })
  })

  it('vazio vira null; uuid inválido vira null; lixo vira objeto vazio tipado', () => {
    expect(normalizarSnapshot('salomao', { salomao_modelo: '   ', salomao_credencial_id: 'abc' })).toEqual({
      salomao_modelo: null, salomao_system_prompt: null, salomao_canais_pagamento: null, salomao_credencial_id: null,
    })
    expect(normalizarSnapshot('sara', null).informa_preco).toBe(false)
  })

  it('salomao_ativo (kill switch) nunca entra no snapshot', () => {
    expect(snapshotDeConfig('salomao', { salomao_ativo: true, salomao_modelo: 'm' })).not.toHaveProperty('salomao_ativo')
  })
})

describe('diff e igualdade', () => {
  it('lista só os campos alterados, com rótulo', () => {
    const d = diffSnapshots('sara', { modelo: 'a', system_prompt: 'p' }, { modelo: 'b', system_prompt: 'p' })
    expect(d).toEqual([{ campo: 'modelo', rotulo: 'Modelo', antes: 'a', depois: 'b' }])
  })

  it('compara normalizado: "" e null são iguais, chave estranha não conta', () => {
    expect(snapshotsIguais('sara', { modelo: '' }, { modelo: null, outra: 1 })).toBe(true)
  })
})

describe('aplicarPatch (Maestro gera rascunho)', () => {
  it('troca só o campo pedido e ignora chave fora da allowlist', () => {
    const base = { modelo: 'gpt-4o', system_prompt: 'velho', informa_preco: true }
    const s = aplicarPatch('sara', base, { system_prompt: 'novo', salomao_ativo: true, followup_ativo: false })
    expect(s.system_prompt).toBe('novo')
    expect(s.modelo).toBe('gpt-4o')
    expect(s.informa_preco).toBe(true)
    expect(s).not.toHaveProperty('salomao_ativo')
  })
})

describe('estadoEditor', () => {
  const cfg = { modelo: 'gpt-4o', system_prompt: 'no ar' }

  it('sem rascunho mostra o que está no ar (config_ia)', () => {
    const e = estadoEditor('sara', { status: 'publicada', snapshot: { modelo: 'velho' } }, null, cfg)
    expect(e.pendente).toBe(false)
    expect(e.snapshot.system_prompt).toBe('no ar')
  })

  it('rascunho diferente do ar fica pendente; igual não', () => {
    expect(estadoEditor('sara', null, { status: 'rascunho', snapshot: { ...cfg, system_prompt: 'novo' } }, cfg).pendente).toBe(true)
    expect(estadoEditor('sara', null, { status: 'rascunho', snapshot: cfg }, cfg).pendente).toBe(false)
  })
})

describe('diffLinhas', () => {
  it('marca linhas removidas e adicionadas preservando as iguais', () => {
    expect(diffLinhas('a\nb\nc', 'a\nx\nc')).toEqual([
      { tipo: 'igual', texto: 'a' }, { tipo: 'del', texto: 'b' }, { tipo: 'add', texto: 'x' }, { tipo: 'igual', texto: 'c' },
    ])
  })

  it('null é tratado como texto vazio', () => {
    expect(diffLinhas(null, 'novo')).toEqual([{ tipo: 'del', texto: '' }, { tipo: 'add', texto: 'novo' }])
  })

  it('textos enormes caem no diff bruto sem estourar', () => {
    const d = diffLinhas('a\nb', 'c\nd', 1)
    expect(d.map((l) => l.tipo)).toEqual(['del', 'del', 'add', 'add'])
  })
})
