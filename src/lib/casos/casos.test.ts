import { describe, it, expect } from 'vitest'
import {
  TRANSICAO_EQUIPE, blocoCasoAberto, estaAberto, instrucaoRetorno, normalizarTipo, validarAbertura, validarNota,
} from './regras'
import { interpretarComando, pareceComando } from './comandos'
import { detectaPromessaHumana, modoGuarda } from './guarda-promessa'
import { textoAviso } from './servico'

describe('regras — transições da equipe', () => {
  it('concluir e pedir info pedem retorno da IA; escalar não', () => {
    expect(TRANSICAO_EQUIPE.concluir).toMatchObject({ para: 'concluido', retorno: true })
    expect(TRANSICAO_EQUIPE.pedir_info).toMatchObject({ para: 'aguardando_familia', retorno: true })
    expect(TRANSICAO_EQUIPE.escalar).toMatchObject({ para: 'escalado', retorno: false })
  })

  it('estados abertos x terminais', () => {
    expect(estaAberto('aguardando_equipe')).toBe(true)
    expect(estaAberto('aguardando_familia')).toBe(true)
    expect(estaAberto('concluido')).toBe(false)
    expect(estaAberto('escalado')).toBe(false)
    expect(estaAberto('cancelado')).toBe(false)
  })
})

describe('regras — validarAbertura', () => {
  it('aceita pedido completo e normaliza o tipo', () => {
    const p = validarAbertura({ titulo: ' Vaga integral ', resumo: 'Mãe quer integral à tarde no G3', motivo: 'não sei', tipo: 'vaga' })
    expect(p).toEqual({ titulo: 'Vaga integral', resumo: 'Mãe quer integral à tarde no G3', motivo: 'não sei', tipo: 'vaga' })
  })

  it('tipo desconhecido vira outro; título ausente sai do resumo', () => {
    const p = validarAbertura({ resumo: 'Pergunta sobre uniforme', tipo: 'xpto' })
    expect(p?.tipo).toBe('outro')
    expect(p?.titulo).toBe('Pergunta sobre uniforme')
  })

  it.each([null, undefined, 'texto', {}, { titulo: 'só título' }, { resumo: '   ' }])('rejeita %j', (v) => {
    expect(validarAbertura(v)).toBeNull()
  })

  it('corta texto acima do limite', () => {
    const p = validarAbertura({ titulo: 'x'.repeat(500), resumo: 'y'.repeat(5000) })
    expect(p?.titulo.length).toBe(200)
    expect(p?.resumo.length).toBe(4000)
  })

  it('normalizarTipo', () => {
    expect(normalizarTipo('financeiro')).toBe('financeiro')
    expect(normalizarTipo(3)).toBe('outro')
  })
})

describe('regras — validarNota', () => {
  it('concluir e pedir info exigem texto', () => {
    expect(validarNota('concluir', '  ').ok).toBe(false)
    expect(validarNota('pedir_info', undefined).ok).toBe(false)
    expect(validarNota('concluir', 'Tem vaga sim')).toEqual({ ok: true, nota: 'Tem vaga sim' })
  })
  it('escalar aceita vazio', () => {
    expect(validarNota('escalar', '')).toEqual({ ok: true, nota: null })
  })
  it('recusa acima de 4000 caracteres (não corta calado)', () => {
    expect(validarNota('concluir', 'a'.repeat(4001)).ok).toBe(false)
  })
})

describe('regras — prompt', () => {
  it('instrução de retorno leva a nota e proíbe citar o Caso', () => {
    const t = instrucaoRetorno('concluir', 'Vaga G3', 'Tem vaga no integral')
    expect(t).toContain('Tem vaga no integral')
    expect(t).toContain('Não preencha "abrir_caso"')
    expect(instrucaoRetorno('pedir_info', 'Vaga', 'Qual a data de nascimento?')).toContain('Qual a data de nascimento?')
  })

  it('bloco do Caso aberto muda conforme o estado', () => {
    expect(blocoCasoAberto(null)).toBe('')
    const fam = blocoCasoAberto({ numero: 3, titulo: 'Vaga', estado: 'aguardando_familia', nota_equipe: 'Qual turno?' })
    expect(fam).toContain('atualizar_caso')
    expect(fam).toContain('Qual turno?')
    const eq = blocoCasoAberto({ numero: 3, titulo: 'Vaga', estado: 'aguardando_equipe', nota_equipe: null })
    expect(eq).toContain('NÃO faça transbordo')
  })
})

describe('comandos #C', () => {
  it('reconhece o formato', () => {
    expect(pareceComando('#C12 ok tem vaga')).toBe(true)
    expect(pareceComando('  #c3 humano')).toBe(true)
    expect(pareceComando('oi, #C12')).toBe(false)
    expect(pareceComando('#Casa')).toBe(false)
  })

  it.each([
    ['#C12 ok Tem vaga no integral', { numero: 12, acao: 'concluir', nota: 'Tem vaga no integral' }],
    ['#c7 pedir: qual a data de nascimento?', { numero: 7, acao: 'pedir_info', nota: 'qual a data de nascimento?' }],
    ['#C1 humano', { numero: 1, acao: 'escalar', nota: '' }],
    ['#C2 Concluído pode vir amanhã\ncom os documentos', { numero: 2, acao: 'concluir', nota: 'pode vir amanhã\ncom os documentos' }],
  ])('interpreta %j', (txt, esperado) => {
    expect(interpretarComando(txt)).toEqual(esperado)
  })

  it('verbo desconhecido devolve ajuda', () => {
    const r = interpretarComando('#C5 talvez')
    expect(r && 'erro' in r && r.erro).toContain('#C5 ok')
  })

  it('não é comando', () => {
    expect(interpretarComando('bom dia')).toBeNull()
  })
})

describe('guarda de promessa', () => {
  it.each([
    'Vou verificar essa informação com a equipe e te retorno em breve! 😊',
    'Deixa eu ver isso. Vou confirmar com a coordenação.',
    'A secretaria vai te retornar ainda hoje.',
    'Assim que souber eu te aviso!',
    'Vou falar com a equipe sobre isso.',
    'Já te retorno!',
  ])('detecta "%s"', (t) => {
    expect(detectaPromessaHumana(t)).not.toBeNull()
  })

  it.each([
    'Temos vagas no G3 integral 😊',
    'Qual é o melhor horário para você?',
    'A visita fica marcada para quinta às 9h.',
    'Nossa equipe é formada por pedagogas experientes.',
    'Vou te mandar o endereço: Rua Avestruz, 271.',
  ])('não dispara em "%s"', (t) => {
    expect(detectaPromessaHumana(t)).toBeNull()
  })

  it('modo default é log', () => {
    expect(modoGuarda(undefined)).toBe('log')
    expect(modoGuarda('ativo')).toBe('ativo')
    expect(modoGuarda('off')).toBe('off')
    expect(modoGuarda('x')).toBe('log')
  })
})

describe('aviso à equipe', () => {
  const caso = {
    numero: 12, agente: 'sara' as const, titulo: 'Vaga G3', resumo: 'Mãe quer integral', motivo_bloqueio: 'Sem dado de vaga',
    nota_equipe: 'Qual o turno?', criado_em: new Date(Date.now() - 25 * 3_600_000).toISOString(),
  }
  it('abertura mostra comandos só quando ligados', () => {
    expect(textoAviso(caso, 'abertura', { comandos: true, familia: 'Ana' })).toContain('#C12 ok')
    expect(textoAviso(caso, 'abertura', { comandos: false })).toContain('tela Casos')
  })
  it('cobrança mostra há quantas horas', () => {
    expect(textoAviso(caso, 'cobranca', { comandos: false })).toContain('25h')
  })
  it('família respondeu leva pedido e resposta', () => {
    const t = textoAviso(caso, 'familia_respondeu', { comandos: false, extra: 'Tarde' })
    expect(t).toContain('Qual o turno?')
    expect(t).toContain('Tarde')
  })
})
