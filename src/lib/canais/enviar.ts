// HANDLER CENTRAL DE ENVIO — o único lugar que decide por qual número a mensagem sai.
//
//   1. relê o canal da conversa (família) e o estado dos canais
//   2. política por operação (politica.ts) → canal; indisponível = erro, sem fallback
//   3. se o chamador avaliou um canal antes (portão/janela), confere que é o mesmo
//   4. idempotência pela chave lógica (se houver)
//   5. portão anti-ban (se `origem` vier) → adapter do canal → transporte
//
// Devolve o canal e a referência usados, para o chamador carimbar a mensagem
// (mensagens.canal_whatsapp / canal_ref). Não grava em `mensagens`: cada
// chamador grava a sua linha com os campos que já gravava (agente, origem, autor).

import { EnvioBarradoError, enviarProtegido, type ContextoEnvio, type ResultadoEnvio } from '@/lib/envio/portao'
import type { OrigemEnvio } from '@/lib/envio/defaults'
import type { MidiaSaida } from '@/lib/whatsapp-cloud'
import { adapterDe, type AdapterCanal } from './adapters'
import { lerCanalDaFamilia, lerEstadoCanais } from './estado'
import { idempotenciaPadrao, type IdempotenciaDeps } from './idempotencia'
import { escolherCanal, refDoCanal } from './politica'
import { CanalDivergenteError, CanalIndisponivelError, type Canal, type EstadoCanais, type Operacao } from './tipos'

export interface PedidoEnvio {
  operacao: Operacao
  telefone: string
  familiaId?: string | null
  leadId?: string | null
  /** Conta Cloud do número pelo qual o lead chegou (familias.whatsapp_phone_number_id). */
  phoneId?: string | null
  texto?: string
  midia?: MidiaSaida
  /** Chave do envio lógico. Mesma chave = no máximo um envio. */
  chave?: string | null
  /** Canal que o chamador já avaliou (portão, janela de 24h). Diferente do relido = aborta. */
  canalEsperado?: Canal | null
  /** Passa pelo portão anti-ban com esta origem. Omitido = o chamador já protegeu. */
  origem?: OrigemEnvio
}

export interface ResultadoCanal {
  wid: string | null
  canal: Canal
  canalRef: string | null
  /** A chave já tinha saído (ou está saindo em outra execução): nada foi enviado agora. */
  duplicado: boolean
}

export interface EnviarDeps {
  estado(phoneId?: string | null): Promise<EstadoCanais>
  canalFamilia(alvo: { familiaId?: string | null; telefone?: string | null }): Promise<string | null>
  adapter(canal: Canal): AdapterCanal
  idem: IdempotenciaDeps
  portao(ctx: ContextoEnvio, texto: string, enviar: () => Promise<string | null>): Promise<ResultadoEnvio>
}

const depsPadrao: EnviarDeps = {
  estado: lerEstadoCanais,
  canalFamilia: lerCanalDaFamilia,
  adapter: adapterDe,
  idem: idempotenciaPadrao,
  portao: (ctx, texto, enviar) => enviarProtegido(ctx, texto, enviar),
}

/** Resolve o canal que um envio desta operação usaria agora, sem enviar. */
export async function resolverCanal(
  p: Pick<PedidoEnvio, 'operacao' | 'telefone' | 'familiaId' | 'phoneId'>,
  deps: Pick<EnviarDeps, 'estado' | 'canalFamilia'> = depsPadrao,
): Promise<{ canal: Canal; canalRef: string | null; disponivel: boolean; motivo?: string; estado: EstadoCanais }> {
  const [estado, canalFamilia] = await Promise.all([
    deps.estado(p.phoneId),
    p.operacao === 'campanha' ? Promise.resolve(null) : deps.canalFamilia({ familiaId: p.familiaId, telefone: p.telefone }),
  ])
  const e = escolherCanal(p.operacao, canalFamilia, estado)
  return { canal: e.canal, canalRef: refDoCanal(e.canal, estado), disponivel: e.ok, motivo: e.ok ? undefined : e.motivo, estado }
}

/**
 * Envia texto OU mídia pelo canal da política.
 * @throws CanalIndisponivelError / CanalDivergenteError — nada saiu.
 * @throws EnvioBarradoError — o portão barrou (só com `origem`); nada saiu.
 * @throws o erro do transporte, depois de marcar a chave como 'falhou'.
 */
export async function enviarPeloCanal(p: PedidoEnvio, deps: EnviarDeps = depsPadrao): Promise<ResultadoCanal> {
  if (!p.texto && !p.midia) throw new Error('enviarPeloCanal: nada para enviar')

  const r = await resolverCanal(p, deps)
  if (!r.disponivel) throw new CanalIndisponivelError(r.canal, r.motivo || 'indisponível')
  if (p.canalEsperado && p.canalEsperado !== r.canal) throw new CanalDivergenteError(p.canalEsperado, r.canal)
  const { canal, canalRef, estado } = r

  if (p.chave) {
    const rv = await deps.idem.reivindicar(p.chave, p.operacao, canal)
    if (rv.tipo === 'ja_enviado') return { wid: rv.wid, canal, canalRef, duplicado: true }
    if (rv.tipo === 'em_andamento') return { wid: null, canal, canalRef, duplicado: true }
  }

  const adapter = deps.adapter(canal)
  const transporte = () =>
    p.midia ? adapter.enviarMidia(p.telefone, p.midia, estado) : adapter.enviarTexto(p.telefone, p.texto as string, estado)

  try {
    let wid: string | null
    if (p.origem) {
      const textoPortao = p.texto ?? p.midia?.caption ?? p.midia?.filename ?? ''
      const g = await deps.portao(
        { origem: p.origem, canal, telefone: p.telefone, leadId: p.leadId, familiaId: p.familiaId },
        textoPortao,
        transporte,
      )
      if (g.status !== 'enviado') {
        if (p.chave) await deps.idem.concluir(p.chave, 'falhou', null, `${g.status}:${g.motivo}`).catch(() => {})
        throw new EnvioBarradoError(g.status, g.motivo)
      }
      wid = g.wid
    } else {
      wid = await transporte()
    }
    if (p.chave) await deps.idem.concluir(p.chave, 'enviado', wid).catch(() => {})
    return { wid, canal, canalRef, duplicado: false }
  } catch (e) {
    if (p.chave && !(e instanceof EnvioBarradoError)) {
      await deps.idem.concluir(p.chave, 'falhou', null, e instanceof Error ? e.message : String(e)).catch(() => {})
    }
    throw e
  }
}

/**
 * Transporte de uma conversa já em curso: resolve o canal UMA vez (para o
 * chamador passar ao portão e carimbar as mensagens) e devolve um `enviar` que
 * aborta se, na hora de cada envio, o canal da conversa tiver mudado.
 */
export async function transporteDaConversa(alvo: {
  telefone: string
  familiaId?: string | null
  leadId?: string | null
  phoneId?: string | null
  operacao?: Exclude<Operacao, 'campanha' | 'aviso_interno'>
}): Promise<{
  canal: Canal
  carimbo: { canal_whatsapp: Canal; canal_ref: string | null }
  enviar: (telefone: string, texto: string) => Promise<string | null>
}> {
  const operacao = alvo.operacao ?? 'resposta'
  const r = await resolverCanal({ operacao, telefone: alvo.telefone, familiaId: alvo.familiaId, phoneId: alvo.phoneId })
  return {
    canal: r.canal,
    carimbo: carimboCanal(r),
    enviar: async (telefone, texto) =>
      (await enviarPeloCanal({
        operacao, telefone, texto, familiaId: alvo.familiaId, leadId: alvo.leadId, phoneId: alvo.phoneId, canalEsperado: r.canal,
      })).wid,
  }
}

/**
 * Recado à EQUIPE (aviso de Caso, notificação ao gestor, alerta de sistema).
 * Sai pelo canal do número de aviso, conta no portão como `aviso_interno` (nunca
 * barrado) e não vira linha na conversa de nenhum lead. Devolve o wid.
 */
export async function enviarAvisoInterno(telefone: string, texto: string, chave?: string | null): Promise<string | null> {
  return (await enviarPeloCanal({ operacao: 'aviso_interno', origem: 'aviso_interno', telefone, texto, chave })).wid
}

/** Campos para carimbar a linha de `mensagens` com o canal usado. */
export function carimboCanal(r: Pick<ResultadoCanal, 'canal' | 'canalRef'>): { canal_whatsapp: Canal; canal_ref: string | null } {
  return { canal_whatsapp: r.canal, canal_ref: r.canalRef }
}
