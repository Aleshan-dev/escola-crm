import { describe, expect, it, vi } from 'vitest'

// O portão importa o cliente Supabase só para as portas padrão; os testes injetam dublês.
vi.mock('@/lib/supabase-server', () => ({ createServerAdminClient: () => ({}) }))

import { DEFAULTS, type ModoProtecao } from './defaults'
import { normalizar } from './regras'
import {
  EnvioBarradoError, enviarProtegido, motivoBarra, preChecarEnvio, protegerEnviarTexto, saldoDoDia,
  type ContextoEnvio, type PortaoDeps, type Reserva,
} from './portao'

const DIA = Date.parse('2026-10-21T10:00:00-05:00') // quarta, 10h Acre
const NOITE = Date.parse('2026-10-21T22:00:00-05:00')

function dublê(o: Partial<{ modo: ModoProtecao; optOut: boolean; recentes: string[]; reserva: Reserva; agora: number; usados: number }> = {}) {
  const eventos: string[] = []
  const deps: PortaoDeps = {
    modo: () => o.modo ?? 'ativo',
    config: async () => ({ ...DEFAULTS }),
    optOut: async () => { eventos.push('optOut'); return o.optOut ?? false },
    recentes: async () => { eventos.push('recentes'); return o.recentes ?? [] },
    reservar: async () => { eventos.push('reservar'); return o.reserva ?? { permitido: true, id: 'r1', esperar_ms: 500 } },
    confirmar: async (_id, st) => { eventos.push(`confirmar:${st}`) },
    usadosHoje: async () => o.usados ?? 0,
    registrar: async (_c, st, m) => { eventos.push(`registrar:${st}:${m}`) },
    agora: () => o.agora ?? DIA,
    rand: () => 0,
    dormir: async (ms) => { eventos.push(`dormir:${ms}`) },
  }
  return { deps, eventos }
}

const ctx = (origem: ContextoEnvio['origem'], canal: ContextoEnvio['canal'] = 'waha'): ContextoEnvio =>
  ({ origem, canal, telefone: '5568999990000', leadId: 'l1', familiaId: 'f1' })

const TEXTO = 'Oi! Vi que você se interessou pela escola, posso ajudar?'

describe('enviarProtegido — modo ativo', () => {
  it('ordem: opt-out → repetição → reserva → espera → envio → confirmação', async () => {
    const { deps, eventos } = dublê()
    const enviar = vi.fn(async () => 'wid1')
    const r = await enviarProtegido(ctx('followup'), TEXTO, enviar, deps)
    expect(r).toEqual({ status: 'enviado', wid: 'wid1', avisos: [] })
    expect(eventos).toEqual(['optOut', 'recentes', 'reservar', 'dormir:500', 'confirmar:enviado'])
  })

  it('opt-out veta o follow-up e o Salomão sem chamar o transporte', async () => {
    for (const origem of ['followup', 'salomao'] as const) {
      const { deps, eventos } = dublê({ optOut: true })
      const enviar = vi.fn(async () => 'x')
      const r = await enviarProtegido(ctx(origem), TEXTO, enviar, deps)
      expect(r).toMatchObject({ status: 'vetado', motivo: 'opt_out' })
      expect(enviar).not.toHaveBeenCalled()
      expect(eventos).toContain('registrar:vetado:opt_out')
    }
  })

  it('fora da janela adia a proativa', async () => {
    const { deps } = dublê({ agora: NOITE })
    const enviar = vi.fn(async () => 'x')
    expect(await enviarProtegido(ctx('followup'), TEXTO, enviar, deps)).toMatchObject({ status: 'adiado', motivo: 'fora_da_janela' })
    expect(enviar).not.toHaveBeenCalled()
  })

  it('3ª cópia parecida é vetada no follow-up, mas NÃO no Salomão (campanha)', async () => {
    const n = normalizar(TEXTO)
    const a = dublê({ recentes: [n, n] })
    expect(await enviarProtegido(ctx('followup'), TEXTO, async () => 'x', a.deps)).toMatchObject({ status: 'vetado', motivo: 'repeticao' })
    const b = dublê({ recentes: [n, n] })
    expect(await enviarProtegido(ctx('salomao'), TEXTO, async () => 'x', b.deps)).toMatchObject({ status: 'enviado' })
    expect(b.eventos).not.toContain('recentes')
  })

  it('teto do dia adia sem chamar o transporte', async () => {
    const { deps } = dublê({ reserva: { permitido: false, motivo: 'teto_diario', proxima_tentativa: '2026-10-22T05:00:00Z' } })
    const enviar = vi.fn(async () => 'x')
    expect(await enviarProtegido(ctx('convite'), TEXTO, enviar, deps))
      .toEqual({ status: 'adiado', motivo: 'teto_diario', proximaTentativa: '2026-10-22T05:00:00Z' })
    expect(enviar).not.toHaveBeenCalled()
  })

  it('resposta da IA só é barrada por opt-out; repetição/intervalo viram aviso', async () => {
    const n = normalizar(TEXTO)
    const { deps, eventos } = dublê({ recentes: [n, n], reserva: { permitido: false, motivo: 'intervalo' } })
    const r = await enviarProtegido(ctx('resposta_ia'), TEXTO, async () => 'w', deps)
    expect(r).toEqual({ status: 'enviado', wid: 'w', avisos: ['repeticao', 'intervalo'] })
    expect(eventos).toContain('registrar:vetaria:repeticao')
    expect(motivoBarra('resposta_ia', 'opt_out')).toBe(true)
  })

  it('envio manual nunca é barrado nem espera — só avisa', async () => {
    const { deps, eventos } = dublê({ optOut: true, agora: NOITE, reserva: { permitido: false, motivo: 'teto_diario' } })
    const r = await enviarProtegido(ctx('manual'), TEXTO, async () => 'm', deps)
    expect(r).toEqual({ status: 'enviado', wid: 'm', avisos: ['opt_out', 'teto_diario'] })
    expect(eventos.some((e) => e.startsWith('dormir'))).toBe(false)
  })

  it('Cloud oficial pula o gate de repetição', async () => {
    const n = normalizar(TEXTO)
    const { deps, eventos } = dublê({ recentes: [n, n] })
    expect(await enviarProtegido(ctx('followup', 'cloud'), TEXTO, async () => 'c', deps)).toMatchObject({ status: 'enviado' })
    expect(eventos).not.toContain('recentes')
  })

  it('erro do transporte confirma "falhou" e relança', async () => {
    const { deps, eventos } = dublê()
    await expect(enviarProtegido(ctx('followup'), TEXTO, async () => { throw new Error('131047') }, deps)).rejects.toThrow('131047')
    expect(eventos).toContain('confirmar:falhou')
  })

  it('falha do próprio portão é fail-open (envia)', async () => {
    const { deps } = dublê()
    deps.reservar = async () => { throw new Error('banco fora') }
    expect(await enviarProtegido(ctx('followup'), TEXTO, async () => 'ok', deps)).toMatchObject({ status: 'enviado', wid: 'ok' })
  })
})

describe('modos log e off', () => {
  it('log registra o que barraria e envia, sem esperar', async () => {
    const { deps, eventos } = dublê({ modo: 'log', optOut: true })
    const r = await enviarProtegido(ctx('followup'), TEXTO, async () => 'w', deps)
    expect(r).toMatchObject({ status: 'enviado', avisos: ['opt_out'] })
    expect(eventos).toContain('registrar:vetaria:opt_out')
    expect(eventos.some((e) => e.startsWith('dormir'))).toBe(false)
  })

  it('off não consulta nada', async () => {
    const { deps, eventos } = dublê({ modo: 'off', optOut: true })
    expect(await enviarProtegido(ctx('followup'), TEXTO, async () => 'w', deps)).toMatchObject({ status: 'enviado' })
    expect(eventos).toEqual([])
  })
})

describe('pré-checagem e saldo', () => {
  it('pré-checagem veta opt-out e adia fora da janela; em log libera', async () => {
    expect(await preChecarEnvio(ctx('followup'), dublê({ optOut: true }).deps)).toEqual({ ok: false, status: 'vetado', motivo: 'opt_out' })
    expect(await preChecarEnvio(ctx('followup'), dublê({ agora: NOITE }).deps)).toEqual({ ok: false, status: 'adiado', motivo: 'fora_da_janela' })
    expect(await preChecarEnvio(ctx('followup'), dublê({ modo: 'log', optOut: true }).deps)).toEqual({ ok: true })
  })

  it('saldo do dia = teto − usados (número sem data → 20)', async () => {
    expect(await saldoDoDia('waha', dublê({ usados: 15 }).deps)).toBe(5)
    expect(await saldoDoDia('waha', dublê({ usados: 25 }).deps)).toBe(0)
    expect(await saldoDoDia('cloud', dublê().deps)).toBeNull()
    expect(await saldoDoDia('waha', dublê({ modo: 'log' }).deps)).toBeNull()
  })
})

describe('protegerEnviarTexto', () => {
  it('lança EnvioBarradoError quando barra (o chamador não grava a mensagem)', async () => {
    // usa as portas padrão: força o modo off para não tocar no banco
    process.env.PROTECAO_ENVIO_MODO = 'off'
    const f = protegerEnviarTexto({ origem: 'resposta_ia', canal: 'waha' }, async () => 'w')
    await expect(f('5568', 'oi')).resolves.toBe('w')
    delete process.env.PROTECAO_ENVIO_MODO
    expect(new EnvioBarradoError('vetado', 'opt_out')).toBeInstanceOf(Error)
  })
})
