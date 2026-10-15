/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase-browser'
import { Topbar } from '@/components/Topbar'
import { ArrowLeft, Loader2, MessageSquareText, Smartphone } from 'lucide-react'

// APP_ID e CONFIG_ID vêm do env para não ficarem chumbados no bundle.
// IMPORTANTE: o CONFIG_ID precisa ser de uma Configuration **v4** do Embedded
// Signup (v2 é descontinuada em 15/out/2026) e habilitada para Coexistência.
const APP_ID = process.env.NEXT_PUBLIC_META_APP_ID || '2451104688636688'
const CONFIG_ID = process.env.NEXT_PUBLIC_META_CONFIG_ID || '1555408462970300'
// Versão do JS SDK do Facebook. Mantida em uma constante para bump fácil.
const FB_SDK_VERSION = process.env.NEXT_PUBLIC_META_FB_VERSION || 'v23.0'

type Conta = {
  id: string
  numero_exibicao: string | null
  nome_verificado: string | null
  phone_number_id: string
  verificado: boolean
  ativo: boolean
}

export default function WhatsappOficialPage() {
  const supabase = createClient()
  const [contas, setContas] = useState<Conta[]>([])
  const [carregando, setCarregando] = useState(true)
  const [conectando, setConectando] = useState(false)
  const [msg, setMsg] = useState('')

  const carregar = useCallback(async () => {
    const { data } = await supabase
      .from('whatsapp_contas')
      .select('id, numero_exibicao, nome_verificado, phone_number_id, verificado, ativo')
      .order('criado_em', { ascending: false })
    setContas((data as unknown as Conta[]) || [])
    setCarregando(false)
  }, [supabase])

  useEffect(() => { carregar() }, [carregar])

  // Carrega o SDK do Facebook
  useEffect(() => {
    if (document.getElementById('fb-sdk')) return
    ;(window as any).fbAsyncInit = function () {
      ;(window as any).FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: FB_SDK_VERSION })
    }
    const s = document.createElement('script')
    s.id = 'fb-sdk'; s.async = true; s.defer = true; s.crossOrigin = 'anonymous'
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    document.body.appendChild(s)
  }, [])

  // Captura os dados que o Embedded Signup envia via postMessage.
  // Em Coexistência (CoEx), o evento de conclusão é
  // FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING e traz o waba_id (o phone_number_id
  // pode vir vazio — o backend resolve pela WABA). Guardamos também o flag coex
  // para o backend PULAR o /register (o número já está registrado no app).
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (typeof ev.origin !== 'string' || !ev.origin.endsWith('facebook.com')) return
      try {
        const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
        if (d?.type !== 'WA_EMBEDDED_SIGNUP') return
        const prev = (window as any).__wa_signup || {}
        const coex = d?.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || prev.coex === true
        ;(window as any).__wa_signup = { ...prev, ...(d.data || {}), coex }
      } catch { /* ignore */ }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  function conectar() {
    const FB = (window as any).FB
    if (!FB) { setMsg('SDK do Facebook ainda carregando — tente de novo em alguns segundos.'); return }
    setMsg(''); setConectando(true)
    ;(window as any).__wa_signup = {} // limpa estado de tentativa anterior
    FB.login(
      (resp: any) => {
        const code = resp?.authResponse?.code
        if (!code) { setConectando(false); setMsg('Conexão cancelada.'); return }
        const info = (window as any).__wa_signup || {}
        fetch('/api/whatsapp-cloud/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            phone_number_id: info.phone_number_id,
            waba_id: info.waba_id,
            coex: info.coex === true,
          }),
        })
          .then((r) => r.json())
          .then((j) => {
            setConectando(false)
            if (j?.ok) {
              const aviso = j?.coex
                ? 'Número conectado em Coexistência! 🎉 O celular continua funcionando. Sincronização de contatos e histórico iniciada (leva alguns minutos).'
                : 'Número conectado com sucesso! 🎉'
              setMsg(aviso + (j?.on_biz_app === false ? ' ⚠️ Atenção: is_on_biz_app veio FALSE — confirme a Config v4/CoEx.' : ''))
              carregar()
            } else {
              setMsg('Falha ao conectar: ' + (j?.erro || 'erro desconhecido') + (j?.detalhe ? ` — ${typeof j.detalhe === 'string' ? j.detalhe : JSON.stringify(j.detalhe)}` : ''))
            }
          })
          .catch(() => { setConectando(false); setMsg('Falha ao salvar a conexão.') })
      },
      {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          // Ativa a tela de Coexistência (conectar o número existente do
          // WhatsApp Business App em vez da seleção padrão de WABA).
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3',
        },
      }
    )
  }

  async function desativar(id: string) {
    await supabase.from('whatsapp_contas').update({ ativo: false }).eq('id', id)
    carregar()
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#EEF2FF]">
      <Topbar />
      <div className="mx-auto w-full max-w-3xl p-6">
        <Link href="/configuracoes" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" /> Configurações
        </Link>

        <div className="mb-1 flex items-center gap-2">
          <MessageSquareText className="h-5 w-5 text-[#1A237E]" />
          <h1 className="text-xl font-bold text-slate-900">WhatsApp Oficial (Meta) — Coexistência</h1>
        </div>
        <p className="mb-5 text-sm text-slate-500">
          Conecte o número da escola pela API oficial da Meta mantendo o <strong>app do celular funcionando</strong> ao
          mesmo tempo (Coexistência). A automação do CRM e o atendimento manual pelo telefone passam a conviver no
          mesmo número.
        </p>

        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Ao concluir a conexão, todos os aparelhos vinculados (WhatsApp Web / dispositivos companheiros) são
            deslogados e precisam ser reconectados. Edição/apagar mensagem deixam de funcionar no número. Você tem
            <strong> 24h</strong> para a sincronização concluir.
          </span>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <button
            onClick={conectar}
            disabled={conectando}
            className="rounded-lg bg-[#1A237E] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#283593] disabled:opacity-60"
          >
            {conectando ? 'Conectando...' : 'Conectar número existente (Coexistência)'}
          </button>
          {msg && <p className="mt-3 text-sm text-slate-600">{msg}</p>}

          <div className="mt-5">
            <div className="mb-2 text-sm font-semibold text-slate-700">Números conectados</div>
            {carregando ? (
              <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Carregando...</div>
            ) : contas.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhum número conectado ainda.</p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {contas.map((c) => (
                  <div key={c.id} className="flex items-center justify-between p-3 text-sm">
                    <div>
                      <div className="font-medium text-slate-800">{c.numero_exibicao || c.phone_number_id}</div>
                      <div className="text-xs text-slate-500">
                        {(c.nome_verificado || '—')} · {c.ativo ? 'ativo' : 'inativo'}
                      </div>
                    </div>
                    {c.ativo && (
                      <button onClick={() => desativar(c.id)} className="text-xs font-medium text-red-600 hover:underline">
                        Desativar
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
