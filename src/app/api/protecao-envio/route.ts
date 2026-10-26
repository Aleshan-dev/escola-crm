import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { BAN_RISK, DEFAULTS, modoProtecao, type Canal } from '@/lib/envio/defaults'
import { invalidarConfigProtecao, lerConfigsProtecao } from '@/lib/envio/config'
import { idadeDoNumeroDias, tetoAquecimento, tetoDoDia } from '@/lib/envio/regras'

// Proteção de envio (anti-ban) por canal: GET mostra o valor EFETIVO de cada campo
// (override do banco ou default do código), o teto de hoje, o consumo do dia e os
// bloqueios recentes por motivo. PUT grava overrides (null = volta ao default).
// Sessão obrigatória (middleware + checagem abaixo); o legado não tem papéis, então
// a trilha é atualizado_por/atualizado_em.

const CANAIS: Canal[] = ['waha', 'evolution', 'cloud']

export async function GET() {
  const db = createServerAdminClient()
  const configs = await lerConfigsProtecao()
  const agora = Date.now()
  const desde7d = new Date(agora - 7 * 86_400_000).toISOString()

  const { data: ledger } = await db
    .from('envio_ledger')
    .select('canal, origem, status, motivo, criado_em')
    .gte('criado_em', desde7d)
    .order('criado_em', { ascending: false })
    .limit(5000)

  const canais = await Promise.all(
    CANAIS.map(async (canal) => {
      const e = configs.get(canal)!
      const { data: usados } = await db.rpc('envio_usados_hoje', { p_canal: canal, p_fuso: e.cfg.fuso })
      const idade = idadeDoNumeroDias(e.cfg.numeroDesde, agora)
      const linhas = (ledger ?? []).filter((l) => l.canal === canal)
      const bloqueios: Record<string, number> = {}
      const porOrigem: Record<string, number> = {}
      for (const l of linhas) {
        if (l.status === 'enviado' || l.status === 'reservado') porOrigem[l.origem] = (porOrigem[l.origem] ?? 0) + 1
        else if (l.status !== 'falhou') {
          const k = `${l.status}:${l.motivo ?? '?'}`
          bloqueios[k] = (bloqueios[k] ?? 0) + 1
        }
      }
      return {
        canal,
        banRisk: BAN_RISK[canal],
        cfg: e.cfg,
        sobrescritos: e.sobrescritos,
        atualizadoPor: e.atualizadoPor,
        atualizadoEm: e.atualizadoEm,
        idadeNumeroDias: idade,
        tetoAquecimentoHoje: e.cfg.pularAquecimento ? null : tetoAquecimento(idade),
        tetoHoje: tetoDoDia(canal, e.cfg, agora),
        usadosHoje: Number(usados ?? 0),
        enviados7d: porOrigem,
        bloqueios7d: bloqueios,
      }
    })
  )

  return NextResponse.json({ modo: modoProtecao(), defaults: DEFAULTS, canais })
}

const hora = (v: unknown) => (v === null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 24 ? Number(v) : NaN)
const ms = (v: unknown) => (v === null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 120000 ? Number(v) : NaN)

export async function PUT(req: NextRequest) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const b = await req.json().catch(() => null)
  const canal = b?.canal as Canal
  if (!CANAIS.includes(canal)) return NextResponse.json({ error: 'Canal inválido' }, { status: 400 })

  const numero_desde = b.numero_desde ? String(b.numero_desde) : null
  if (numero_desde && !/^\d{4}-\d{2}-\d{2}$/.test(numero_desde)) return NextResponse.json({ error: 'Data inválida' }, { status: 400 })
  if (numero_desde && Date.parse(numero_desde) > Date.now()) return NextResponse.json({ error: 'A data de uso do número não pode ser no futuro' }, { status: 400 })

  const row = {
    numero_desde,
    pular_aquecimento: b.pular_aquecimento === true,
    janela_resposta_ini: hora(b.janela_resposta_ini),
    janela_resposta_fim: hora(b.janela_resposta_fim),
    janela_disparo_ini: hora(b.janela_disparo_ini),
    janela_disparo_fim: hora(b.janela_disparo_fim),
    domingo_disparo: typeof b.domingo_disparo === 'boolean' ? b.domingo_disparo : null,
    intervalo_min_ms: ms(b.intervalo_min_ms),
    jitter_max_ms: ms(b.jitter_max_ms),
    teto_diario: b.teto_diario === null || b.teto_diario === '' ? null : Number(b.teto_diario),
    fuso: b.fuso ? String(b.fuso) : null,
    atualizado_por: user.email ?? user.id,
    atualizado_em: new Date().toISOString(),
  }
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'number' && Number.isNaN(v)) return NextResponse.json({ error: `Valor inválido em ${k}` }, { status: 400 })
  }
  if (row.teto_diario != null && (!Number.isInteger(row.teto_diario) || row.teto_diario < 0)) {
    return NextResponse.json({ error: 'Teto diário inválido' }, { status: 400 })
  }
  // Janela é par: ou os dois lados, ou nenhum (volta ao default).
  for (const j of ['resposta', 'disparo'] as const) {
    const ini = row[`janela_${j}_ini`], fim = row[`janela_${j}_fim`]
    if ((ini == null) !== (fim == null)) return NextResponse.json({ error: `Informe início e fim da janela de ${j}` }, { status: 400 })
  }
  if (row.fuso) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: row.fuso }) } catch { return NextResponse.json({ error: 'Fuso inválido' }, { status: 400 }) }
  }

  const db = createServerAdminClient()
  const { error } = await db.from('canal_protecao').upsert({ canal, ...row })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  invalidarConfigProtecao()
  console.log(`[protecao-envio] canal=${canal} alterado por ${row.atualizado_por}`)
  return NextResponse.json({ ok: true })
}
