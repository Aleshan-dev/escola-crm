'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Topbar } from '@/components/Topbar'
import { ArrowLeft, BarChart3, FlaskConical, Loader2, Plus, Route, Save, Trash2 } from 'lucide-react'

type Config = {
  classificador_ligado: boolean
  credencial_id: string | null
  modelo: string | null
  min_confianca: number
  historico_msgs: number
  atualizado_por: string | null
  atualizado_em: string | null
}
type Intencao = { id?: string; nome: string; descricao: string; exemplos: string[]; agente: 'sara' | 'salomao' | 'humano'; ativo: boolean; ordem: number }
type Cred = { id: string; provedor: string; nome: string | null; ultimos4: string | null; validada: boolean }
type Cenario = { guarda: string; rota: string; resultado: string; intencao: string | null; confianca: number | null }
type Teste = {
  classificacao: { ok: boolean; intencao?: string | null; confianca?: number; erro?: string }
  minConfianca: number
  classificadorLigado: boolean
  familiaNova: Cenario
  familiaMatriculada: Cenario
}

const AGENTE: Record<string, string> = { sara: 'Sara (captação)', salomao: 'Salomão (matriculados)', humano: 'Pessoa da equipe' }
const RESULTADO: Record<string, string> = {
  guarda: 'Regra do vínculo SGEI (classificador não rodou)',
  classificado: 'Intenção confirma o agente',
  escalado_humano: 'Encaminhada para uma pessoa (IA pausada)',
  vetado_guarda: 'Intenção apontou outro agente — ignorada pela regra do vínculo',
  sem_match: 'Nenhuma intenção — fica o agente da regra',
  baixa_confianca: 'Confiança abaixo do mínimo — fica o agente da regra',
  falha: 'Classificador falhou — fica o agente da regra',
}

const VAZIA: Intencao = { nome: '', descricao: '', exemplos: [], agente: 'humano', ativo: true, ordem: 50 }

export default function RoteadorPage() {
  const [config, setConfig] = useState<Config | null>(null)
  const [intencoes, setIntencoes] = useState<Intencao[]>([])
  const [creds, setCreds] = useState<Cred[]>([])
  const [modeloPadrao, setModeloPadrao] = useState('')
  const [msg, setMsg] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [editando, setEditando] = useState<Intencao | null>(null)
  const [erroInt, setErroInt] = useState('')
  const [frase, setFrase] = useState('')
  const [testando, setTestando] = useState(false)
  const [teste, setTeste] = useState<Teste | null>(null)
  const [erroTeste, setErroTeste] = useState('')

  async function load() {
    const j = await (await fetch('/api/roteador')).json()
    setConfig(j.config)
    setIntencoes(j.intencoes)
    setCreds(j.credenciais)
    setModeloPadrao(j.modeloPadrao)
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  async function salvarConfig() {
    if (!config) return
    setSalvando(true)
    const r = await fetch('/api/roteador', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) })
    const j = await r.json()
    setSalvando(false)
    setMsg(r.ok ? 'Salvo.' : j.error || 'Falha ao salvar')
    if (r.ok) load()
  }

  async function salvarIntencao() {
    if (!editando) return
    setErroInt('')
    const r = await fetch('/api/roteador', {
      method: editando.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editando),
    })
    const j = await r.json()
    if (!r.ok) return setErroInt(j.error || 'Falha ao salvar')
    setEditando(null)
    load()
  }

  async function removerIntencao(id: string) {
    if (!confirm('Remover esta intenção?')) return
    await fetch(`/api/roteador?id=${id}`, { method: 'DELETE' })
    load()
  }

  async function testar() {
    setTestando(true); setErroTeste(''); setTeste(null)
    const r = await fetch('/api/roteador/testar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto: frase }) })
    const j = await r.json()
    setTestando(false)
    if (!r.ok) return setErroTeste(j.error || 'Falha no teste')
    setTeste(j)
  }

  if (!config) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50">
        <Topbar />
        <div className="p-5 flex items-center gap-2 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Carregando...</div>
      </div>
    )
  }
  const inp = 'w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm'

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <div className="flex items-start justify-between gap-3 mb-1">
          <h1 className="text-xl font-semibold flex items-center gap-2"><Route className="w-5 h-5 text-blue-600" /> Roteador de agentes</h1>
          <Link href="/configuracoes/roteador/decisoes" className="shrink-0 inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
            <BarChart3 className="w-4 h-4" /> Decisões
          </Link>
        </div>
        <p className="text-sm text-slate-500 mb-6">
          Decide <b>qual agente de IA</b> atende cada mensagem. Não confundir com a distribuição entre pessoas da equipe.
          A regra principal é fixa: família <b>matriculada</b> (vínculo no SGEI) → Salomão; família <b>nova</b> → Sara.
          O classificador de intenção é uma camada opcional por cima: ele só pode <b>manter</b> esse agente ou
          <b> encaminhar a conversa para uma pessoa</b> (pausando a IA). Ele nunca manda uma família matriculada para a Sara.
        </p>

        {/* Config */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 mb-6">
          <h2 className="font-semibold text-slate-800 mb-3">Classificador de intenção</h2>
          <label className="flex items-start gap-2 text-sm mb-3">
            <input type="checkbox" className="mt-0.5" checked={config.classificador_ligado} onChange={(e) => setConfig({ ...config, classificador_ligado: e.target.checked })} />
            <span>
              Ligado
              <span className="block text-xs text-slate-500">Desligado = só a regra do vínculo SGEI (comportamento de sempre). Ligado = uma chamada de IA por mensagem recebida (custo e ~1s a mais).</span>
            </span>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <label className="block">
              <span className="text-xs text-slate-500">Credencial (provedor)</span>
              <select className={inp} value={config.credencial_id ?? ''} onChange={(e) => setConfig({ ...config, credencial_id: e.target.value || null })}>
                <option value="">Automático — a mesma da Sara</option>
                {creds.map((c) => <option key={c.id} value={c.id}>{c.nome || c.provedor} ····{c.ultimos4}{c.validada ? '' : ' (não validada)'}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Modelo — vazio = {modeloPadrao}</span>
              <input className={inp} placeholder={modeloPadrao} value={config.modelo ?? ''} onChange={(e) => setConfig({ ...config, modelo: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Confiança mínima para agir — padrão 0,60</span>
              <input type="number" step={0.05} min={0} max={1} className={inp} value={config.min_confianca} onChange={(e) => setConfig({ ...config, min_confianca: Number(e.target.value) })} />
              <span className="text-[11px] text-slate-400">É o número que a própria IA devolve, não uma garantia de acerto. Mais alto = escala menos.</span>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Mensagens anteriores como contexto (0–16)</span>
              <input type="number" min={0} max={16} className={inp} value={config.historico_msgs} onChange={(e) => setConfig({ ...config, historico_msgs: Number(e.target.value) })} />
              <span className="text-[11px] text-slate-400">Ajuda a entender respostas curtas (&quot;sim&quot;, &quot;a primeira&quot;). Mais contexto = mais custo.</span>
            </label>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button onClick={salvarConfig} disabled={salvando} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
              {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar
            </button>
            {msg && <span className="text-sm text-slate-600">{msg}</span>}
            {config.atualizado_por && <span className="text-xs text-slate-400 ml-auto">alterado por {config.atualizado_por}{config.atualizado_em ? ` em ${new Date(config.atualizado_em).toLocaleString('pt-BR')}` : ''}</span>}
          </div>
        </section>

        {/* Intenções */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-800">Intenções</h2>
            <button onClick={() => { setErroInt(''); setEditando({ ...VAZIA }) }} className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"><Plus className="w-4 h-4" /> Nova intenção</button>
          </div>
          <p className="text-xs text-slate-500 mb-3">
            A qualidade do roteamento depende da descrição e dos exemplos. Intenções com agente <b>Pessoa da equipe</b> são as que mudam algo:
            com confiança suficiente, a IA é pausada e o gestor recebe o aviso de transbordo. As de Sara/Salomão servem para classificar e medir.
          </p>
          <div className="space-y-2">
            {intencoes.map((i) => (
              <div key={i.id} className={`rounded-lg border p-3 ${i.ativo ? 'border-slate-200' : 'border-dashed border-slate-200 opacity-60'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{i.nome} <span className="ml-1 text-xs font-normal text-slate-500">→ {AGENTE[i.agente]}{!i.ativo && ' · inativa'}</span></div>
                    <div className="text-xs text-slate-600">{i.descricao}</div>
                    {i.exemplos.length > 0 && <div className="text-xs text-slate-400 mt-1">Ex.: {i.exemplos.map((e) => `“${e}”`).join(' · ')}</div>}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => { setErroInt(''); setEditando({ ...i }) }} className="text-xs text-blue-600 hover:underline">Editar</button>
                    <button onClick={() => removerIntencao(i.id!)} className="text-slate-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {editando && (
            <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-2 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="block"><span className="text-xs text-slate-500">Nome (minúsculas e _)</span>
                  <input className={inp} value={editando.nome} onChange={(e) => setEditando({ ...editando, nome: e.target.value })} />
                </label>
                <label className="block"><span className="text-xs text-slate-500">Quem atende</span>
                  <select className={inp} value={editando.agente} onChange={(e) => setEditando({ ...editando, agente: e.target.value as Intencao['agente'] })}>
                    {Object.entries(AGENTE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
              </div>
              <label className="block"><span className="text-xs text-slate-500">Situação que a intenção representa</span>
                <textarea rows={2} className={inp} value={editando.descricao} onChange={(e) => setEditando({ ...editando, descricao: e.target.value })} />
              </label>
              <label className="block"><span className="text-xs text-slate-500">Frases de exemplo (uma por linha, até 10)</span>
                <textarea rows={3} className={inp} value={editando.exemplos.join('\n')} onChange={(e) => setEditando({ ...editando, exemplos: e.target.value.split('\n') })} />
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={editando.ativo} onChange={(e) => setEditando({ ...editando, ativo: e.target.checked })} /> Ativa</label>
              {erroInt && <div className="text-xs text-red-600">{erroInt}</div>}
              <div className="flex gap-2">
                <button onClick={salvarIntencao} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700">Salvar intenção</button>
                <button onClick={() => setEditando(null)} className="rounded-lg px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">Cancelar</button>
              </div>
            </div>
          )}
        </section>

        {/* Teste */}
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2"><FlaskConical className="w-4 h-4" /> Testar classificação</h2>
          <p className="text-xs text-slate-500 mb-3">
            Usa a mesma lógica e o mesmo mínimo da produção, sem criar conversa nem gravar decisão. <b>Chama a IA</b> (tem custo), mesmo com o classificador desligado.
            Não simula histórico: é uma prévia da frase, não de uma conversa inteira.
          </p>
          <div className="flex gap-2">
            <input className={inp} placeholder="Ex.: quero falar com a diretora, estou muito chateada" value={frase} onChange={(e) => setFrase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && frase.trim() && testar()} />
            <button onClick={testar} disabled={testando || !frase.trim()} className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm text-white disabled:opacity-60">
              {testando ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Testar'}
            </button>
          </div>
          {erroTeste && <div className="text-sm text-red-600 mt-2">{erroTeste}</div>}
          {teste && (
            <div className="mt-3 space-y-2 text-sm">
              <div className="rounded-lg bg-slate-50 p-3">
                {teste.classificacao.ok
                  ? <>Intenção: <b>{teste.classificacao.intencao ?? 'nenhuma (none)'}</b> · confiança <b>{Math.round((teste.classificacao.confianca ?? 0) * 100)}%</b> (mínimo {Math.round(teste.minConfianca * 100)}%)</>
                  : <>Classificador falhou: <code>{teste.classificacao.erro}</code></>}
                {!teste.classificadorLigado && <div className="text-xs text-amber-700 mt-1">O classificador está desligado: em produção, hoje, vale só a regra do vínculo.</div>}
              </div>
              {([['Família nova', teste.familiaNova], ['Família matriculada', teste.familiaMatriculada]] as const).map(([rot, c]) => (
                <div key={rot} className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs text-slate-500">{rot} — pela regra: {AGENTE[c.guarda] || c.guarda}</div>
                  <div>Atende: <b>{AGENTE[c.rota] || c.rota}</b></div>
                  <div className="text-xs text-slate-600">{RESULTADO[c.resultado] || c.resultado}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
