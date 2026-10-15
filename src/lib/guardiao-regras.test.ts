import { describe, it, expect } from 'vitest'
import { acreWallToUtc } from './disponibilidade'
import {
  decidirAcao,
  lerEstado,
  instanciaSaudavel,
  horaAcreDe,
  minutosDesdeRestart,
  COOLDOWN_RESTART_MS,
  HORA_RESTART_DIARIO,
  type EntradaGuardiao,
} from './guardiao-regras'

const MIN = 60 * 1000
const agora = acreWallToUtc(2026, 6, 29, 14, 0).getTime() // 29/07/2026 14h Acre

const base: EntradaGuardiao = {
  agoraMs: agora,
  estado: 'open',
  ultimoRestartMs: 0,
  janelaDiaria: false,
}

describe('horaAcreDe', () => {
  it('converte para o fuso de Acre', () => {
    expect(horaAcreDe(acreWallToUtc(2026, 6, 29, 6, 0).getTime())).toBe(HORA_RESTART_DIARIO)
    expect(horaAcreDe(acreWallToUtc(2026, 6, 29, 23, 30).getTime())).toBe(23)
  })
})

describe('minutosDesdeRestart', () => {
  it('devolve Infinity quando nunca houve restart', () => {
    expect(minutosDesdeRestart(0, agora)).toBe(Infinity)
  })
  it('calcula os minutos decorridos', () => {
    expect(minutosDesdeRestart(agora - 10 * MIN, agora)).toBe(10)
  })
})

describe('lerEstado', () => {
  it('lê o formato aninhado do Evolution', () => {
    expect(lerEstado({ instance: { state: 'open' } })).toBe('open')
  })
  it('lê o formato plano', () => {
    expect(lerEstado({ state: 'close' })).toBe('close')
  })
  it('cai para desconhecido em payload inesperado', () => {
    expect(lerEstado(null)).toBe('desconhecido')
    expect(lerEstado({})).toBe('desconhecido')
    expect(lerEstado({ state: 'qualquer_coisa' })).toBe('desconhecido')
  })
})

describe('instanciaSaudavel', () => {
  it('só "open" é saudável', () => {
    expect(instanciaSaudavel('open')).toBe(true)
    expect(instanciaSaudavel('connecting')).toBe(false)
    expect(instanciaSaudavel('close')).toBe(false)
    expect(instanciaSaudavel('desconhecido')).toBe(false)
  })
})

describe('decidirAcao', () => {
  it('não faz nada quando está tudo bem', () => {
    expect(decidirAcao(base)).toBe('nada')
  })

  it('reinicia para recuperar instância caída', () => {
    expect(decidirAcao({ ...base, estado: 'close' })).toBe('restart_recuperacao')
  })

  it('trata API fora do ar (desconhecido) como queda', () => {
    expect(decidirAcao({ ...base, estado: 'desconhecido' })).toBe('restart_recuperacao')
  })

  it('NÃO reinicia enquanto a instância está conectando', () => {
    expect(decidirAcao({ ...base, estado: 'connecting' })).toBe('aguardando_conexao')
    // mesmo na janela diária: derrubar quem está subindo só atrasa a volta
    expect(decidirAcao({ ...base, estado: 'connecting', janelaDiaria: true })).toBe('aguardando_conexao')
  })

  it('faz o restart preventivo na janela diária mesmo estando saudável', () => {
    expect(decidirAcao({ ...base, janelaDiaria: true })).toBe('restart_diario')
  })

  it('respeita o cooldown para não entrar em loop de restart', () => {
    const recente = { ...base, estado: 'close' as const, ultimoRestartMs: agora - 5 * MIN }
    expect(decidirAcao(recente)).toBe('cooldown')
  })

  it('o cooldown vence até o restart diário', () => {
    const recente = { ...base, janelaDiaria: true, ultimoRestartMs: agora - 5 * MIN }
    expect(decidirAcao(recente)).toBe('cooldown')
  })

  it('volta a reiniciar depois que o cooldown expira', () => {
    const expirado = {
      ...base,
      estado: 'close' as const,
      ultimoRestartMs: agora - (COOLDOWN_RESTART_MS + MIN),
    }
    expect(decidirAcao(expirado)).toBe('restart_recuperacao')
  })

  it('reproduz o incidente de 28/07: queda às 18h dispara recuperação na hora', () => {
    const dezoitoHoras = acreWallToUtc(2026, 6, 28, 18, 30).getTime()
    const acao = decidirAcao({
      agoraMs: dezoitoHoras,
      estado: 'close',
      ultimoRestartMs: 0,
      janelaDiaria: false,
    })
    // Antes desta rotina, isso só seria notado no dia seguinte.
    expect(acao).toBe('restart_recuperacao')
  })
})
