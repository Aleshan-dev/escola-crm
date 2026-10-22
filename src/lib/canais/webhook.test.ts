import { createHmac } from 'crypto'
import { describe, expect, it } from 'vitest'
import { assinaturaMetaValida, conexaoConfere, resultadoDaIngestao, segredoConfere } from './webhook'

describe('assinaturaMetaValida', () => {
  const corpo = '{"entry":[{"id":"1"}]}'
  const assinar = (c: string, s: string) => 'sha256=' + createHmac('sha256', s).update(c).digest('hex')

  it('aceita a assinatura do corpo bruto com o app secret', () => {
    expect(assinaturaMetaValida(corpo, assinar(corpo, 'seg'), 'seg')).toBe(true)
  })
  it('rejeita segredo errado, corpo alterado, cabeçalho ausente ou malformado', () => {
    expect(assinaturaMetaValida(corpo, assinar(corpo, 'outro'), 'seg')).toBe(false)
    expect(assinaturaMetaValida(corpo + ' ', assinar(corpo, 'seg'), 'seg')).toBe(false)
    expect(assinaturaMetaValida(corpo, null, 'seg')).toBe(false)
    expect(assinaturaMetaValida(corpo, 'sha1=abc', 'seg')).toBe(false)
  })
})

describe('segredoConfere', () => {
  it('compara o segredo inteiro', () => {
    expect(segredoConfere('abc', 'abc')).toBe(true)
    expect(segredoConfere('ab', 'abc')).toBe(false)
    expect(segredoConfere(null, 'abc')).toBe(false)
  })
})

describe('conexaoConfere', () => {
  it('evento da sessão configurada passa; de outra sessão não', () => {
    expect(conexaoConfere('org_1', 'org_1')).toBe(true)
    expect(conexaoConfere('Salomao-crm', 'org_1')).toBe(false)
  })
  it('evento sem o campo (formato antigo) passa', () => {
    expect(conexaoConfere(undefined, 'org_1')).toBe(true)
    expect(conexaoConfere('', 'org_1')).toBe(true)
  })
})

describe('resultadoDaIngestao', () => {
  it('traduz o retorno da ingestão para a trilha', () => {
    expect(resultadoDaIngestao('duplicada_ignorada').resultado).toBe('duplicado')
    expect(resultadoDaIngestao('fromMe_sara').resultado).toBe('duplicado')
    expect(resultadoDaIngestao('fromMe_sem_familia').resultado).toBe('descartado')
    expect(resultadoDaIngestao('registrado_out_humano').resultado).toBe('ingerido')
    expect(resultadoDaIngestao('3f2c-lead-id').resultado).toBe('ingerido')
  })
})
