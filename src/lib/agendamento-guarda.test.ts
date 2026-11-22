import { describe, expect, it } from 'vitest'
import {
  afirmaAgendamento,
  casarSlotAfirmado,
  conferirSlotComTexto,
  ehOfertaDeHorarios,
  horasNoTexto,
  textoCitaInstante,
} from './agendamento-guarda'

// Acre = UTC-5: 09:30 Acre = 14:30Z; 07:30 Acre = 12:30Z; 14:00 Acre = 19:00Z.
const S_24_0930 = { id: 'v1', data_hora: '2026-11-24T14:30:00.000Z' }
const S_25_1400 = { id: 'v2', data_hora: '2026-11-25T19:00:00.000Z' }
const S_24_0730 = { id: 'v1', data_hora: '2026-11-24T12:30:00.000Z' }

const OFERTA_AMANDA =
  'Que alegria, Amanda! Para você conhecer de perto o Berçário II, nossa rotina e ver as câmeras ao vivo funcionando, tenho duas opções de horário na agenda.\n' +
  'Pode ser na terça-feira, dia 24/11, às 09:30 ou na quarta-feira, dia 25/11, às 14:00? Qual fica melhor para você? 😊'
const CONFIRMA_AMANDA =
  'Prontinho, Amanda! Já deixei agendada a nossa visita para a terça-feira, 24/11, às 09:30. Nosso endereço é Rua Aloísio de Azevedo, 114.'

describe('caso Amanda (22/11/2026)', () => {
  it('oferta de dois horários NÃO é agendamento', () => {
    expect(ehOfertaDeHorarios(OFERTA_AMANDA)).toBe(true)
    expect(afirmaAgendamento(OFERTA_AMANDA)).toBe(false)
  })

  it('a confirmação depois da escolha é agendamento', () => {
    expect(ehOfertaDeHorarios(CONFIRMA_AMANDA)).toBe(false)
    expect(afirmaAgendamento(CONFIRMA_AMANDA)).toBe(true)
    expect(casarSlotAfirmado(CONFIRMA_AMANDA, [S_24_0930, S_25_1400])).toBe('v1')
  })

  it('slot_id que aponta para outro horário do que a Sara disse é recusado', () => {
    // No 2º turno o "v1" já era 07:30; a Sara falou 09:30.
    expect(conferirSlotComTexto('v1', CONFIRMA_AMANDA, [S_24_0730])).toBeNull()
    // Se o 09:30 estiver na lista com outro id, usa o certo.
    expect(conferirSlotComTexto('v1', CONFIRMA_AMANDA, [S_24_0730, { ...S_24_0930, id: 'v3' }])).toBe('v3')
  })
})

describe('afirmaAgendamento', () => {
  it.each([
    'Agendei sua visita para quarta 25/11 às 14:00.',
    'Remarquei para 15h30, combinado?'.replace('?', '.'),
    'Ficou agendada para amanhã às 9:00.',
    'Está tudo agendado para 26/11 às 08:00!',
    // Confirmações reais de novembro/2026 (Beatrice, Kamila, Nayra) continuam valendo:
    'Perfeito, Beatrice! Já deixei agendado para amanhã, quinta-feira, 19/11, às 10:30. 💙',
    'Combinado, Kamila! Está agendado para hoje, segunda-feira, 16/11 às 15:00, na Rua Aloísio de Azevedo, 114.',
    'Perfeito, Nayra! Já deixei nossa visita agendada para quinta-feira, 12/11, às 08:30.',
  ])('afirma: %s', (t) => expect(afirmaAgendamento(t)).toBe(true))

  it.each([
    'Quer agendar uma visita? Tenho 24/11 às 09:30.',
    'Sua visita está confirmada para amanhã às 9:00, te esperamos!',
    'Vou ver a agenda e te retorno.',
    'Já deixei agendado!', // sem horário: não dá para casar nada
  ])('não afirma: %s', (t) => expect(afirmaAgendamento(t)).toBe(false))
})

describe('utilitários', () => {
  it('lê horários em vários formatos', () => {
    expect([...horasNoTexto('às 9:30, 14h00 ou 7h05')]).toEqual(['09:30', '14:00', '07:05'])
  })
  it('cita instante pela parede de Acre', () => {
    expect(textoCitaInstante('dia 24/11 às 09:30', S_24_0930.data_hora)).toBe(true)
    expect(textoCitaInstante('dia 24/11 às 07:30', S_24_0930.data_hora)).toBe(false)
  })
  it('texto sem horário confia no slot do modelo', () => {
    expect(conferirSlotComTexto('v1', 'Combinado, te espero!', [S_24_0930])).toBe('v1')
  })
})
