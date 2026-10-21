import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { decidirPolitica } from '@/lib/maestro/politica'
import { classificarIntencao } from '@/lib/roteador/classificador'
import { resolverRota } from '@/lib/roteador/resolver'
import { lerConfigRoteador } from '@/lib/roteador/turno'

// "Testar classificação": classifica uma frase com a MESMA lógica e o mesmo mínimo
// da produção e mostra intenção, confiança, agente e resultado — para uma família
// nova e para uma matriculada. Não cria conversa nem grava decisão. CHAMA A IA
// (tem custo), mesmo com o classificador desligado (é para testar antes de ligar).
export async function POST(req: NextRequest) {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })

  const b = await req.json().catch(() => null)
  const texto = String(b?.texto ?? '').trim()
  if (!texto) return NextResponse.json({ error: 'Digite uma frase' }, { status: 400 })

  const db = createServerAdminClient()
  const cfg = await lerConfigRoteador(db)
  if (cfg.intencoes.length === 0) return NextResponse.json({ error: 'Cadastre ao menos uma intenção ativa' }, { status: 400 })

  const { data: ia } = await db.from('config_ia').select('salomao_ativo').eq('id', 1).maybeSingle()
  const salomaoAtivo = ia?.salomao_ativo === true

  const classificacao = await classificarIntencao(db, {
    intencoes: cfg.intencoes,
    texto,
    credencialId: cfg.credencialId,
    modelo: cfg.modelo,
  })

  const cenario = (jaResponsavel: boolean) => {
    const guarda = decidirPolitica({ optOut: false, precisaAtendimentoHumano: false, iaAtiva: true, jaResponsavel, salomaoAtivo })
    return { guarda: guarda.rota, ...resolverRota(guarda, classificacao, cfg.intencoes, cfg.minConfianca) }
  }

  return NextResponse.json({
    classificacao,
    minConfianca: cfg.minConfianca,
    classificadorLigado: cfg.classificadorLigado,
    familiaNova: cenario(false),
    familiaMatriculada: cenario(true),
  })
}
