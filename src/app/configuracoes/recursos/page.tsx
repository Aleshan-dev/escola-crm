import Link from 'next/link'
import { Topbar } from '@/components/Topbar'
import { createServerAdminClient } from '@/lib/supabase-server'
import { modoProtecao } from '@/lib/envio/defaults'
import { ArrowLeft, ChevronRight } from 'lucide-react'

// Inventário SOMENTE LEITURA do que está ligado no sistema. Cada linha mostra o
// estado e leva à tela onde aquilo é configurado. Não altera nada aqui, para não
// criar um segundo caminho para mudar a mesma opção. Variáveis de ambiente
// (MAESTRO_ATIVO etc.) só mudam na Vercel + redeploy.

export const dynamic = 'force-dynamic'

type Estado = 'ligado' | 'desligado' | 'parcial' | 'atencao'
type Recurso = { nome: string; estado: Estado; detalhe: string; onde: string; href?: string }

const COR: Record<Estado, string> = {
  ligado: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  desligado: 'bg-slate-50 text-slate-500 border-slate-200',
  parcial: 'bg-blue-50 text-blue-700 border-blue-200',
  atencao: 'bg-amber-50 text-amber-700 border-amber-200',
}
const ROTULO: Record<Estado, string> = { ligado: 'Ligado', desligado: 'Desligado', parcial: 'Só observando', atencao: 'Atenção' }

async function coletar(): Promise<{ grupo: string; itens: Recurso[] }[]> {
  const db = createServerAdminClient()
  const [{ data: ia }, { data: rot }, { count: intencoes }, { data: prot }, { data: google }, { count: contasCloud }] = await Promise.all([
    db.from('config_ia').select('salomao_ativo, followup_ativo').eq('id', 1).maybeSingle(),
    db.from('roteador_config').select('classificador_ligado, min_confianca').eq('id', 1).maybeSingle(),
    db.from('roteador_intencoes').select('id', { count: 'exact', head: true }).eq('ativo', true),
    db.from('canal_protecao').select('canal, numero_desde, pular_aquecimento'),
    db.from('integracao_google').select('id').eq('id', 1).maybeSingle(),
    db.from('whatsapp_contas').select('id', { count: 'exact', head: true }).eq('ativo', true),
  ])

  const maestro = process.env.MAESTRO_ATIVO === 'true'
  const validacao = (process.env.VALIDACAO_SAIDA_MODO || 'log').toLowerCase()
  const protecao = modoProtecao()
  const provedor = (process.env.WHATSAPP_PROVIDER || 'evolution').toLowerCase() === 'waha' ? 'waha' : 'evolution'
  const semData = (prot ?? []).filter((p) => p.canal !== 'cloud' && !p.numero_desde && !p.pular_aquecimento).map((p) => p.canal)

  return [
    {
      grupo: 'Agentes de IA',
      itens: [
        { nome: 'Salomão (matriculados)', estado: ia?.salomao_ativo ? 'ligado' : 'desligado', detalhe: ia?.salomao_ativo ? 'Atende famílias com vínculo no SGEI.' : 'Família matriculada vai para atendimento humano.', onde: 'Salomão', href: '/configuracoes/salomao' },
        { nome: 'Follow-up automático', estado: ia?.followup_ativo ? 'ligado' : 'desligado', detalhe: 'Toques da Sara por etapa do funil.', onde: 'Follow-up', href: '/configuracoes/followup' },
        {
          nome: 'Classificador do roteador', estado: rot?.classificador_ligado ? 'ligado' : 'desligado',
          detalhe: rot?.classificador_ligado
            ? `${intencoes ?? 0} intenção(ões) ativa(s), mínimo ${Math.round(Number(rot.min_confianca) * 100)}%.`
            : 'Só a regra do vínculo SGEI decide o agente.',
          onde: 'Roteador', href: '/configuracoes/roteador',
        },
        { nome: 'Maestro Guardião (opt-out + log de rota)', estado: maestro ? 'ligado' : 'desligado', detalhe: 'Variável MAESTRO_ATIVO. Ligado = detecta "pare de mandar" e registra cada decisão de rota.', onde: 'Vercel (variável de ambiente)', href: '/configuracoes/maestro' },
        { nome: 'Validação da resposta da IA', estado: validacao === 'off' ? 'desligado' : validacao === 'ativo' ? 'ligado' : 'parcial', detalhe: `Variável VALIDACAO_SAIDA_MODO = ${validacao}. Confere promessa de desconto, valores e fatos proibidos.`, onde: 'Vercel (variável de ambiente)' },
      ],
    },
    {
      grupo: 'Canais e envio',
      itens: [
        { nome: 'Proteção de envio (anti-ban)', estado: protecao === 'ativo' ? 'ligado' : protecao === 'log' ? 'parcial' : 'desligado', detalhe: `Variável PROTECAO_ENVIO_MODO = ${protecao}.${protecao === 'log' ? ' Registra o que barraria, sem barrar.' : ''}`, onde: 'Proteção de envio', href: '/configuracoes/protecao-envio' },
        ...(semData.length
          ? [{ nome: 'Idade dos números', estado: 'atencao' as Estado, detalhe: `Sem "número usado desde" em: ${semData.join(', ')}. Em modo ativo o teto vira 20 envios proativos/dia.`, onde: 'Proteção de envio', href: '/configuracoes/protecao-envio' }]
          : []),
        { nome: 'Canal não-oficial ativo', estado: 'ligado', detalhe: `Variável WHATSAPP_PROVIDER = ${provedor}. Salomão e convites saem por aqui.`, onde: provedor === 'waha' ? 'WAHA' : 'Evolution', href: provedor === 'waha' ? '/configuracoes/waha' : '/configuracoes/whatsapp' },
        { nome: 'WhatsApp oficial (Cloud API)', estado: (contasCloud ?? 0) > 0 ? 'ligado' : 'desligado', detalhe: `${contasCloud ?? 0} conta(s) ativa(s).`, onde: 'WhatsApp Oficial', href: '/configuracoes/whatsapp-oficial' },
      ],
    },
    {
      grupo: 'Integrações',
      itens: [
        { nome: 'Google Agenda', estado: google ? 'parcial' : 'desligado', detalhe: google ? 'Conectado em algum momento. O estado real do token aparece na tela de Integrações.' : 'Nunca conectado.', onde: 'Integrações', href: '/configuracoes/integracoes' },
      ],
    },
  ]
}

export default async function RecursosPage() {
  const grupos = await coletar()
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <Topbar />
      <div className="p-5 max-w-3xl mx-auto w-full">
        <Link href="/configuracoes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Configurações
        </Link>
        <h1 className="text-xl font-semibold mb-1">Recursos e interruptores</h1>
        <p className="text-sm text-slate-500 mb-6">
          Inventário do que está ligado. Esta tela só mostra: cada item leva ao lugar onde ele é configurado.
          Itens marcados como &quot;variável de ambiente&quot; mudam na Vercel e exigem novo deploy.
        </p>
        <div className="space-y-6">
          {grupos.map((g) => (
            <section key={g.grupo}>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">{g.grupo}</h2>
              <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                {g.itens.map((r) => {
                  const corpo = (
                    <div className="flex items-start gap-3 p-3">
                      <span className={`shrink-0 mt-0.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${COR[r.estado]}`}>{ROTULO[r.estado]}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{r.nome}</div>
                        <div className="text-xs text-slate-500">{r.detalhe}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">Onde mudar: {r.onde}</div>
                      </div>
                      {r.href && <ChevronRight className="w-4 h-4 text-slate-300 shrink-0 mt-1" />}
                    </div>
                  )
                  return r.href
                    ? <Link key={r.nome} href={r.href} className="block hover:bg-slate-50">{corpo}</Link>
                    : <div key={r.nome}>{corpo}</div>
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
