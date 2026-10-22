import { describe, expect, it, vi } from 'vitest'
import { EnvioBarradoError } from '@/lib/envio/portao'
import { adapterDe, type AdapterCanal } from './adapters'
import { enviarPeloCanal, type EnviarDeps } from './enviar'
import { decidirChaveExistente, PENDENTE_TTL_MS, type Reivindicacao } from './idempotencia'
import { CanalDivergenteError, CanalIndisponivelError, type Canal, type EstadoCanais } from './tipos'

vi.mock('@/lib/supabase-server', () => ({ createServerAdminClient: () => ({}) }))

const ESTADO: EstadoCanais = {
  cloud: null, wahaConfigurado: true, evolutionConfigurado: true, canalDisparo: 'waha',
  wahaSessao: 'org_1', evolutionInstancia: 'inst',
}

function montar(over: {
  canalFamilia?: string | null
  estado?: Partial<EstadoCanais>
  reivindicacao?: Reivindicacao
  portao?: EnviarDeps['portao']
  falhaTransporte?: Error
} = {}) {
  const enviados: { canal: Canal; to: string; texto: string }[] = []
  const conclusoes: { chave: string; status: string }[] = []
  const adapter = (canal: Canal): AdapterCanal => ({
    canal,
    async enviarTexto(to, texto) {
      if (over.falhaTransporte) throw over.falhaTransporte
      enviados.push({ canal, to, texto })
      return `wid-${canal}`
    },
    async enviarMidia() { return null },
  })
  const deps: EnviarDeps = {
    estado: async () => ({ ...ESTADO, ...over.estado }),
    canalFamilia: async () => (over.canalFamilia === undefined ? 'waha' : over.canalFamilia),
    adapter,
    idem: {
      reivindicar: async () => over.reivindicacao ?? { tipo: 'nova' },
      concluir: async (chave, status) => { conclusoes.push({ chave, status }) },
    },
    portao: over.portao ?? (async (_ctx, _t, enviar) => ({ status: 'enviado', wid: await enviar(), avisos: [] })),
  }
  return { deps, enviados, conclusoes }
}

describe('enviarPeloCanal', () => {
  it('sai pelo canal da conversa e devolve o carimbo', async () => {
    const { deps, enviados } = montar()
    const r = await enviarPeloCanal({ operacao: 'resposta', telefone: '5568999', texto: 'oi' }, deps)
    expect(r).toEqual({ wid: 'wid-waha', canal: 'waha', canalRef: 'org_1', duplicado: false })
    expect(enviados).toEqual([{ canal: 'waha', to: '5568999', texto: 'oi' }])
  })

  it('canal da conversa fora: lança e NADA sai por outro canal', async () => {
    const { deps, enviados } = montar({ estado: { wahaConfigurado: false } })
    await expect(enviarPeloCanal({ operacao: 'followup', telefone: 'x', texto: 'oi' }, deps))
      .rejects.toBeInstanceOf(CanalIndisponivelError)
    expect(enviados).toEqual([])
  })

  it('canal relido diferente do avaliado pelo chamador: aborta antes do transporte', async () => {
    const { deps, enviados } = montar({ canalFamilia: 'evolution' })
    await expect(enviarPeloCanal({ operacao: 'followup', telefone: 'x', texto: 'oi', canalEsperado: 'waha' }, deps))
      .rejects.toBeInstanceOf(CanalDivergenteError)
    expect(enviados).toEqual([])
  })

  it('chave já enviada: devolve o wid antigo sem reenviar', async () => {
    const { deps, enviados } = montar({ reivindicacao: { tipo: 'ja_enviado', wid: 'w-velho' } })
    const r = await enviarPeloCanal({ operacao: 'followup', telefone: 'x', texto: 'oi', chave: 'k' }, deps)
    expect(r).toMatchObject({ wid: 'w-velho', duplicado: true })
    expect(enviados).toEqual([])
  })

  it('chave em andamento em outra execução: não envia', async () => {
    const { deps, enviados } = montar({ reivindicacao: { tipo: 'em_andamento' } })
    const r = await enviarPeloCanal({ operacao: 'followup', telefone: 'x', texto: 'oi', chave: 'k' }, deps)
    expect(r.duplicado).toBe(true)
    expect(enviados).toEqual([])
  })

  it('chave nova: envia e conclui como enviado', async () => {
    const { deps, conclusoes } = montar()
    await enviarPeloCanal({ operacao: 'followup', telefone: 'x', texto: 'oi', chave: 'k' }, deps)
    expect(conclusoes).toEqual([{ chave: 'k', status: 'enviado' }])
  })

  it('erro do transporte: marca a chave como falhou (retry permitido) e relança', async () => {
    const { deps, conclusoes } = montar({ falhaTransporte: new Error('WAHA 500') })
    await expect(enviarPeloCanal({ operacao: 'followup', telefone: 'x', texto: 'oi', chave: 'k' }, deps)).rejects.toThrow('WAHA 500')
    expect(conclusoes).toEqual([{ chave: 'k', status: 'falhou' }])
  })

  it('portão barra: EnvioBarradoError, nada sai, chave liberada', async () => {
    const { deps, enviados, conclusoes } = montar({
      portao: async () => ({ status: 'adiado', motivo: 'teto_diario', proximaTentativa: null }),
    })
    await expect(enviarPeloCanal({ operacao: 'aviso_interno', origem: 'aviso_interno', telefone: 'x', texto: 'oi', chave: 'k' }, deps))
      .rejects.toBeInstanceOf(EnvioBarradoError)
    expect(enviados).toEqual([])
    expect(conclusoes).toEqual([{ chave: 'k', status: 'falhou' }])
  })

  it('sem origem não passa pelo portão (o chamador já protegeu)', async () => {
    const portao = vi.fn()
    const { deps } = montar({ portao })
    await enviarPeloCanal({ operacao: 'resposta', telefone: 'x', texto: 'oi' }, deps)
    expect(portao).not.toHaveBeenCalled()
  })
})

describe('adapterDe — registry fail-closed', () => {
  it('canal conhecido tem adapter', () => {
    expect(adapterDe('waha').canal).toBe('waha')
    expect(adapterDe('cloud').canal).toBe('cloud')
    expect(adapterDe('evolution').canal).toBe('evolution')
  })

  it('canal desconhecido lança em vez de cair num padrão', () => {
    expect(() => adapterDe('wacalls')).toThrow(CanalIndisponivelError)
    expect(() => adapterDe('')).toThrow(CanalIndisponivelError)
  })
})

describe('decidirChaveExistente', () => {
  const agora = Date.parse('2026-10-22T12:00:00Z')
  const ha = (ms: number) => new Date(agora - ms).toISOString()

  it('enviado: devolve o wid', () => {
    expect(decidirChaveExistente({ status: 'enviado', wid: 'w', atualizado_em: ha(0) }, agora)).toEqual({ tipo: 'ja_enviado', wid: 'w' })
  })
  it('pendente recente: em andamento', () => {
    expect(decidirChaveExistente({ status: 'pendente', wid: null, atualizado_em: ha(60_000) }, agora)).toEqual({ tipo: 'em_andamento' })
  })
  it('pendente órfão ou falhou: retoma', () => {
    expect(decidirChaveExistente({ status: 'pendente', wid: null, atualizado_em: ha(PENDENTE_TTL_MS + 1) }, agora)).toEqual({ tipo: 'retomada' })
    expect(decidirChaveExistente({ status: 'falhou', wid: null, atualizado_em: ha(0) }, agora)).toEqual({ tipo: 'retomada' })
  })
})
