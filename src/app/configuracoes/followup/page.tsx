'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { BotaoRodarCron } from '@/components/BotaoRodarCron'
import { Loader2, AlertTriangle, Send, MessageCircle, Sparkles, CheckCircle2 } from 'lucide-react'

type LeadOpt = {
  id: string
  familia: { nome_responsavel: string | null; telefone: string | null } | null
  coluna: { nome: string | null } | null
}

type Preview = {
  ok: boolean
  etapa_sem_followup?: boolean
  nome: string | null
  telefone: string
  coluna: string
  trigger?: string
  followup_count?: number
  followup_max?: number
  marco?: string
  janela_aberta?: boolean
  decisao?: 'enviaria_cloud' | 'criaria_alerta_manual'
  mensagem?: string
  baloes?: string[]
  anotacoes?: { conteudo: string; criado_em: string }[]
}

export default function FollowupConfigPage() {
  const supabase = createClient()
  const [ativo, setAtivo] = useState<boolean | null>(null)
  const [salvando, setSalvando] = useState(false)
  const [leads, setLeads] = useState<LeadOpt[]>([])
  const [sel, setSel] = useState('')
  const [rodando, setRodando] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data: cfg } = await supabase.from('config_ia').select('followup_ativo').eq('id', 1).maybeSingle()
      setAtivo((cfg as { followup_ativo?: boolean } | null)?.followup_ativo ?? false)
      const { data } = await supabase
        .from('leads')
        .select('id, familia:familias(nome_responsavel, telefone), coluna:colunas(nome)')
        .eq('arquivado', false)
        .order('atualizado_em', { ascending: false })
        .limit(200)
      setLeads((data as unknown as LeadOpt[]) || [])
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function toggle(novo: boolean) {
    if (salvando) return
    if (
      novo &&
      !confirm(
        'Ligar o follow-up AUTOMÁTICO?\n\nA partir de agora o sistema vai enviar mensagens sozinho (Cloud, dentro da janela de 24h) e criar alertas manuais (fora da janela) para TODOS os leads elegíveis. Recomendado só depois de validar no preview abaixo. Confirmar?'
      )
    )
      return
    setSalvando(true)
    try {
      await supabase.from('config_ia').update({ followup_ativo: novo }).eq('id', 1)
      setAtivo(novo)
    } finally {
      setSalvando(false)
    }
  }

  async function rodarPreview() {
    if (!sel || rodando) return
    setRodando(true)
    setErro(null)
    setPreview(null)
    try {
      const r = await fetch('/api/followup/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: sel }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'falha ao gerar o preview')
      setPreview(j as Preview)
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'erro desconhecido')
    } finally {
      setRodando(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="mx-auto w-full max-w-3xl p-5">
        <h1 className="text-xl font-semibold">Follow-up automático</h1>
        <p className="mb-6 text-sm text-slate-500">
          O motor que reengaja leads por etapa do funil. Dentro da janela de 24h envia pela API Cloud;
          fora dela, cria um alerta de envio manual em <strong>Pendentes</strong>.
        </p>

        {/* Interruptor */}
        <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-800">Status do follow-up</span>
                {ativo === null ? (
                  <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                ) : ativo ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">
                    <CheckCircle2 className="h-3 w-3" /> Ligado
                  </span>
                ) : (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-600">Desligado</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                Controla a flag <code className="rounded bg-slate-100 px-1">config_ia.followup_ativo</code>. Desligado = nada é enviado.
              </p>
            </div>
            <button
              onClick={() => toggle(!ativo)}
              disabled={salvando || ativo === null}
              className={`relative h-6 w-11 flex-shrink-0 rounded-full transition disabled:opacity-50 ${ativo ? 'bg-green-500' : 'bg-slate-300'}`}
              aria-label="Ligar/desligar follow-up"
            >
              <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition ${ativo ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          {!ativo && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>Valide no preview abaixo com 2-3 leads antes de ligar. Ligar ativa o envio para todos os leads elegíveis de uma vez.</span>
            </div>
          )}
        </div>

        {/* Rodar agora: dispara o cron de follow-up na hora, sem esperar os 15 min.
            Só age se o interruptor acima estiver ligado (o cron gateia em followup_ativo). */}
        <div className="mb-5">
          <BotaoRodarCron />
        </div>

        {/* Preview por lead */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Sparkles className="h-4 w-4 text-blue-600" /> Testar em um lead (preview)
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            Mostra o gatilho, a mensagem que a Sara geraria, se a janela está aberta e a decisão — <strong>sem enviar nada</strong>.
          </p>

          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              value={sel}
              onChange={(e) => setSel(e.target.value)}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Selecione um lead…</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.familia?.nome_responsavel || 'Sem nome'} — {l.coluna?.nome || 'sem etapa'}
                </option>
              ))}
            </select>
            <button
              onClick={rodarPreview}
              disabled={!sel || rodando}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Rodar preview
            </button>
          </div>

          {erro && <div className="mt-3 rounded-lg bg-red-50 p-2.5 text-xs text-red-700">{erro}</div>}

          {preview && preview.etapa_sem_followup && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
              A etapa <strong>{preview.coluna}</strong> não tem follow-up (ex.: Matriculados / Perdidos). Nada seria enviado.
            </div>
          )}

          {preview && !preview.etapa_sem_followup && (
            <div className="mt-4 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-slate-400">Etapa</div>
                  <div className="font-medium text-slate-700">{preview.coluna}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-slate-400">Gatilho</div>
                  <div className="font-mono font-medium text-slate-700">{preview.trigger}</div>
                  {preview.marco && <div className="mt-0.5 text-[11px] text-slate-500">{preview.marco}</div>}
                </div>
                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-slate-400">{preview.trigger === 'followup_pos_visita' ? 'Toque (régua 14d)' : 'Tentativa'}</div>
                  <div className="font-medium text-slate-700">
                    {(preview.followup_count ?? 0) + 1} / {preview.followup_max}
                  </div>
                </div>
                <div className="rounded-lg bg-slate-50 p-2">
                  <div className="text-slate-400">Janela 24h</div>
                  <div className={`font-medium ${preview.janela_aberta ? 'text-green-600' : 'text-amber-600'}`}>
                    {preview.janela_aberta ? 'Aberta' : 'Fechada'}
                  </div>
                </div>
              </div>

              <div
                className={`flex items-center gap-2 rounded-lg p-2.5 text-sm font-medium ${
                  preview.janela_aberta ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
                }`}
              >
                {preview.janela_aberta ? <Send className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
                {preview.janela_aberta
                  ? 'Enviaria automaticamente pela API Cloud (texto livre).'
                  : 'Criaria um alerta de envio manual em Pendentes (copiar/abrir no WhatsApp).'}
              </div>

              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">
                  Anotações que a Sara considerou{' '}
                  <span className={preview.anotacoes && preview.anotacoes.length > 0 ? 'text-green-600' : 'text-amber-600'}>
                    ({preview.anotacoes?.length ?? 0})
                  </span>
                </div>
                {preview.anotacoes && preview.anotacoes.length > 0 ? (
                  <ul className="space-y-1">
                    {preview.anotacoes.map((a, i) => (
                      <li key={i} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                        <span className="text-slate-400">
                          {a.criado_em ? new Date(a.criado_em).toLocaleDateString('pt-BR') : ''}{' '}
                        </span>
                        {a.conteudo}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
                    Este lead não tem anotações — não há contexto de notas para a Sara usar.
                  </p>
                )}
              </div>

              <div>
                <div className="mb-1 text-xs font-medium text-slate-500">Mensagem que a Sara enviaria:</div>
                <div className="space-y-1.5">
                  {(preview.baloes && preview.baloes.length > 0 ? preview.baloes : [preview.mensagem || '']).map((b, i) => (
                    <div key={i} className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-green-100 px-3 py-2 text-sm text-green-900">
                      {b}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
