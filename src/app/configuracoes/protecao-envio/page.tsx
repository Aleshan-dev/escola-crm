'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Topbar } from '@/components/Topbar'
import { AlertTriangle, ArrowLeft, Loader2, Save, ShieldCheck } from 'lucide-react'

type Cfg = {
  numeroDesde: string | null
  pularAquecimento: boolean
  janelaResposta: [number, number]
  janelaDisparo: [number, number]
  domingoDisparo: boolean
  intervaloMinMs: number
  jitterMaxMs: number
  tetoDiario: number | null
  fuso: string
}
type CanalInfo = {
  canal: 'waha' | 'evolution' | 'cloud'
  banRisk: boolean
  cfg: Cfg
  sobrescritos: (keyof Cfg)[]
  atualizadoPor: string | null
  atualizadoEm: string | null
  idadeNumeroDias: number
  tetoAquecimentoHoje: number | null
  tetoHoje: number | null
  usadosHoje: number
  enviados7d: Record<string, number>
  bloqueios7d: Record<string, number>
}
type Resp = { modo: 'off' | 'log' | 'ativo'; defaults: Cfg; canais: CanalInfo[] }

const NOME: Record<CanalInfo['canal'], string> = {
  waha: 'WAHA (número não-oficial)',
  evolution: 'Evolution (número não-oficial)',
  cloud: 'WhatsApp oficial (Cloud API)',
}
const MOTIVO: Record<string, string> = {
  opt_out: 'família pediu para parar',
  fora_da_janela: 'fora do horário',
  domingo: 'domingo',
  repeticao: 'texto repetido',
  teto_diario: 'teto do dia',
  intervalo: 'intervalo entre envios',
}
const STATUS: Record<string, string> = { vetado: 'Vetado', adiado: 'Adiado', vetaria: 'Teria barrado' }
const ORIGEM: Record<string, string> = {
  resposta_ia: 'Resposta da IA', followup: 'Follow-up', salomao: 'Salomão', convite: 'Convites',
  manual: 'Manual', reengajar: 'Retomada', aviso_interno: 'Aviso à equipe',
}

// Form: string vazia = "usar o padrão".
type Form = Record<string, string | boolean>

function formDe(c: CanalInfo): Form {
  const s = new Set(c.sobrescritos)
  const v = (k: keyof Cfg, f: () => string) => (s.has(k) ? f() : '')
  return {
    numero_desde: c.cfg.numeroDesde ?? '',
    pular_aquecimento: c.cfg.pularAquecimento,
    janela_resposta_ini: v('janelaResposta', () => String(c.cfg.janelaResposta[0])),
    janela_resposta_fim: v('janelaResposta', () => String(c.cfg.janelaResposta[1])),
    janela_disparo_ini: v('janelaDisparo', () => String(c.cfg.janelaDisparo[0])),
    janela_disparo_fim: v('janelaDisparo', () => String(c.cfg.janelaDisparo[1])),
    domingo_disparo: v('domingoDisparo', () => String(c.cfg.domingoDisparo)),
    intervalo_min_ms: v('intervaloMinMs', () => String(c.cfg.intervaloMinMs)),
    jitter_max_ms: v('jitterMaxMs', () => String(c.cfg.jitterMaxMs)),
    teto_diario: v('tetoDiario', () => String(c.cfg.tetoDiario ?? '')),
    fuso: v('fuso', () => c.cfg.fuso),
  }
}

export default function ProtecaoEnvioPage() {
  const [dados, setDados] = useState<Resp | null>(null)
  const [forms, setForms] = useState<Record<string, Form>>({})
  const [salvando, setSalvando] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})

  async function load() {
    const r = await fetch('/api/protecao-envio')
    const j: Resp = await r.json()
    setDados(j)
    setForms(Object.fromEntries(j.canais.map((c) => [c.canal, formDe(c)])))
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  const set = (canal: string, k: string, v: string | boolean) =>
    setForms((f) => ({ ...f, [canal]: { ...f[canal], [k]: v } }))

  async function salvar(canal: string) {
    const f = forms[canal]
    setSalvando(canal)
    setMsg((m) => ({ ...m, [canal]: '' }))
    const n = (x: string | boolean) => (x === '' ? null : x)
    const r = await fetch('/api/protecao-envio', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        canal,
        ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, n(v)])),
        domingo_disparo: f.domingo_disparo === '' ? null : f.domingo_disparo === 'true',
      }),
    })
    const j = await r.json()
    setSalvando(null)
    setMsg((m) => ({ ...m, [canal]: r.ok ? 'Salvo.' : j.error || 'Falha ao salvar' }))
    if (r.ok) load()
  }

  if (!dados) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50">
        <Topbar />
        <div className="p-5 flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
      </div>
    )
  }
  const d = dados.defaults

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <h1 className="text-xl font-semibold mb-1 flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-emerald-600" /> Proteção de envio</h1>
        <p className="text-sm text-slate-500 mb-3">
          Ritmo por número antes de cada mensagem sair: horário, intervalo entre envios, teto do dia,
          aquecimento de número novo, texto repetido e opt-out. Reduz padrões de risco. <b>Não garante</b> que
          o WhatsApp não bloqueie: denúncias, bloqueios e falta de consentimento pesam mais que o ritmo.
        </p>

        <div className={`rounded-xl border p-3 text-sm mb-6 ${dados.modo === 'ativo' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          Modo atual: <b>{dados.modo}</b>.{' '}
          {dados.modo === 'log' && 'Nada é barrado ainda: o sistema só registra o que teria barrado ("Teria barrado" abaixo). '}
          {dados.modo === 'off' && 'Proteção desligada. '}
          {dados.modo === 'ativo' && 'Os envios proativos são barrados/adiados. A resposta da IA só para por opt-out; o envio manual nunca é barrado. '}
          Para mudar: variável <code>PROTECAO_ENVIO_MODO</code> (off | log | ativo) na Vercel.
        </div>

        <div className="space-y-6">
          {dados.canais.map((c) => {
            const f = forms[c.canal] || {}
            const inp = 'w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm'
            return (
              <section key={c.canal} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h2 className="font-semibold text-slate-800">{NOME[c.canal]}</h2>
                    <p className="text-xs text-slate-500">
                      {c.banRisk
                        ? 'Canal com risco de bloqueio por volume: vale ritmo, aquecimento e teto.'
                        : 'Canal oficial: sem teto/aquecimento locais (a Meta limita por qualidade). Vale horário e opt-out.'}
                    </p>
                  </div>
                  {c.banRisk && (
                    <div className="text-right text-sm shrink-0">
                      <div className="font-semibold">{c.usadosHoje}{c.tetoHoje != null ? ` / ${c.tetoHoje}` : ''}</div>
                      <div className="text-xs text-slate-500">envios hoje{c.tetoHoje == null ? ' (sem teto)' : ''}</div>
                    </div>
                  )}
                </div>

                {c.banRisk && (
                  <div className="text-xs text-slate-600 mb-3">
                    Número com <b>{c.idadeNumeroDias}</b> dia(s) de uso{!c.cfg.numeroDesde && ' (sem data informada: tratado como novo)'}.
                    {' '}Aquecimento de hoje: <b>{c.cfg.pularAquecimento ? 'desligado' : c.tetoAquecimentoHoje ?? 'sem teto'}</b>
                    {c.tetoAquecimentoHoje != null && !c.cfg.pularAquecimento && ' mensagens proativas'}.
                    {' '}Degraus: 20/dia (0–3 dias), 50 (4–7), 100 (8–14), 200 (15–30), sem teto depois.
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  {c.banRisk && (
                    <>
                      <label className="block">
                        <span className="text-xs text-slate-500">Número usado desde</span>
                        <input type="date" className={inp} value={String(f.numero_desde ?? '')} onChange={(e) => set(c.canal, 'numero_desde', e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-xs text-slate-500">Teto diário (vazio = só o aquecimento)</span>
                        <input type="number" min={0} className={inp} placeholder="sem teto" value={String(f.teto_diario ?? '')} onChange={(e) => set(c.canal, 'teto_diario', e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-xs text-slate-500">Intervalo mínimo entre envios (ms) — padrão {d.intervaloMinMs}</span>
                        <input type="number" min={0} className={inp} placeholder={String(d.intervaloMinMs)} value={String(f.intervalo_min_ms ?? '')} onChange={(e) => set(c.canal, 'intervalo_min_ms', e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-xs text-slate-500">Variação aleatória (ms) — padrão até {d.jitterMaxMs}</span>
                        <input type="number" min={0} className={inp} placeholder={String(d.jitterMaxMs)} value={String(f.jitter_max_ms ?? '')} onChange={(e) => set(c.canal, 'jitter_max_ms', e.target.value)} />
                      </label>
                    </>
                  )}
                  <div>
                    <span className="text-xs text-slate-500">Horário de disparo (proativo) — padrão {d.janelaDisparo[0]}h–{d.janelaDisparo[1]}h</span>
                    <div className="flex gap-2">
                      <input type="number" min={0} max={24} className={inp} placeholder={String(d.janelaDisparo[0])} value={String(f.janela_disparo_ini ?? '')} onChange={(e) => set(c.canal, 'janela_disparo_ini', e.target.value)} />
                      <input type="number" min={0} max={24} className={inp} placeholder={String(d.janelaDisparo[1])} value={String(f.janela_disparo_fim ?? '')} onChange={(e) => set(c.canal, 'janela_disparo_fim', e.target.value)} />
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-slate-500">Horário de resposta — padrão {d.janelaResposta[0]}h–{d.janelaResposta[1]}h (sempre)</span>
                    <div className="flex gap-2">
                      <input type="number" min={0} max={24} className={inp} placeholder={String(d.janelaResposta[0])} value={String(f.janela_resposta_ini ?? '')} onChange={(e) => set(c.canal, 'janela_resposta_ini', e.target.value)} />
                      <input type="number" min={0} max={24} className={inp} placeholder={String(d.janelaResposta[1])} value={String(f.janela_resposta_fim ?? '')} onChange={(e) => set(c.canal, 'janela_resposta_fim', e.target.value)} />
                    </div>
                  </div>
                  <label className="block">
                    <span className="text-xs text-slate-500">Disparo no domingo</span>
                    <select className={inp} value={String(f.domingo_disparo ?? '')} onChange={(e) => set(c.canal, 'domingo_disparo', e.target.value)}>
                      <option value="">Padrão ({d.domingoDisparo ? 'permitido' : 'bloqueado'})</option>
                      <option value="true">Permitido</option>
                      <option value="false">Bloqueado</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-slate-500">Fuso — padrão {d.fuso}</span>
                    <input className={inp} placeholder={d.fuso} value={String(f.fuso ?? '')} onChange={(e) => set(c.canal, 'fuso', e.target.value)} />
                  </label>
                </div>

                {c.banRisk && (
                  <label className="mt-3 flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5" checked={f.pular_aquecimento === true} onChange={(e) => set(c.canal, 'pular_aquecimento', e.target.checked)} />
                    <span>
                      Número já aquecido — pular o aquecimento
                      {f.pular_aquecimento === true && (
                        <span className="flex items-center gap-1 text-xs text-amber-700 mt-1">
                          <AlertTriangle className="w-3.5 h-3.5" /> Em número novo isso aumenta muito o risco de bloqueio. Só marque se o número já envia volume há mais de 30 dias.
                        </span>
                      )}
                    </span>
                  </label>
                )}

                <div className="mt-4 flex items-center gap-3">
                  <button onClick={() => salvar(c.canal)} disabled={salvando === c.canal} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                    {salvando === c.canal ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar
                  </button>
                  {msg[c.canal] && <span className="text-sm text-slate-600">{msg[c.canal]}</span>}
                  {c.atualizadoEm && c.sobrescritos.length > 0 && (
                    <span className="text-xs text-slate-400 ml-auto">alterado por {c.atualizadoPor || '—'} em {new Date(c.atualizadoEm).toLocaleString('pt-BR')}</span>
                  )}
                </div>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg bg-slate-50 p-3">
                    <div className="font-semibold text-slate-700 mb-1">Enviados (7 dias)</div>
                    {Object.keys(c.enviados7d).length === 0 ? <div className="text-slate-400">nenhum registro</div> :
                      Object.entries(c.enviados7d).map(([o, n]) => <div key={o} className="flex justify-between"><span>{ORIGEM[o] || o}</span><b>{n}</b></div>)}
                  </div>
                  <div className="rounded-lg bg-slate-50 p-3">
                    <div className="font-semibold text-slate-700 mb-1">Barrados / adiados (7 dias)</div>
                    {Object.keys(c.bloqueios7d).length === 0 ? <div className="text-slate-400">nenhum</div> :
                      Object.entries(c.bloqueios7d).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
                        const [st, mo] = k.split(':')
                        return <div key={k} className="flex justify-between gap-2"><span>{STATUS[st] || st} — {MOTIVO[mo] || mo}</span><b>{n}</b></div>
                      })}
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
