import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServerAdminClient } from '@/lib/supabase-server'
import { MODELO_PADRAO } from '@/lib/roteador/classificador'

// Roteador (camada de intenção): GET devolve config + TODAS as intenções (inclusive
// inativas) + credenciais disponíveis (sem a chave). PUT grava a config.
// Intenções: POST cria, PATCH edita (por id), DELETE remove (?id=).

async function exigirUsuario() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  return user
}

export async function GET() {
  const db = createServerAdminClient()
  const [{ data: config }, { data: intencoes }, { data: creds }] = await Promise.all([
    db.from('roteador_config').select('*').eq('id', 1).maybeSingle(),
    db.from('roteador_intencoes').select('*').order('ordem').order('criado_em'),
    db.from('ia_credenciais').select('id, provedor, nome, ultimos4, validada').order('criado_em', { ascending: false }),
  ])
  return NextResponse.json({ config, intencoes: intencoes ?? [], credenciais: creds ?? [], modeloPadrao: MODELO_PADRAO })
}

export async function PUT(req: NextRequest) {
  const user = await exigirUsuario()
  if (!user) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  const b = await req.json().catch(() => null)
  const min = Number(b?.min_confianca)
  const hist = Number(b?.historico_msgs)
  if (!(min >= 0 && min <= 1)) return NextResponse.json({ error: 'Confiança mínima deve ficar entre 0 e 1' }, { status: 400 })
  if (!(Number.isInteger(hist) && hist >= 0 && hist <= 16)) return NextResponse.json({ error: 'Histórico: de 0 a 16 mensagens' }, { status: 400 })
  const db = createServerAdminClient()
  const { error } = await db.from('roteador_config').upsert({
    id: 1,
    classificador_ligado: b?.classificador_ligado === true,
    credencial_id: b?.credencial_id || null,
    modelo: String(b?.modelo ?? '').trim() || null,
    min_confianca: min,
    historico_msgs: hist,
    atualizado_por: user.email ?? user.id,
    atualizado_em: new Date().toISOString(),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

function validarIntencao(b: Record<string, unknown> | null): { erro: string } | { row: Record<string, unknown> } {
  const nome = String(b?.nome ?? '').trim()
  const descricao = String(b?.descricao ?? '').trim()
  const agente = String(b?.agente ?? '')
  const exemplos = (Array.isArray(b?.exemplos) ? b!.exemplos : [])
    .map((e) => String(e).trim())
    .filter(Boolean)
  if (!/^[a-z0-9_]{2,60}$/.test(nome) || nome === 'none') return { erro: 'Nome: 2–60 letras minúsculas, números ou _ (e não "none")' }
  if (descricao.length < 5) return { erro: 'Descreva a situação que a intenção representa' }
  if (!['sara', 'salomao', 'humano'].includes(agente)) return { erro: 'Agente inválido' }
  if (exemplos.length > 10) return { erro: 'No máximo 10 exemplos' }
  return { row: { nome, descricao, agente, exemplos, ativo: b?.ativo !== false, ordem: Number(b?.ordem) || 0 } }
}

export async function POST(req: NextRequest) {
  if (!(await exigirUsuario())) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  const v = validarIntencao(await req.json().catch(() => null))
  if ('erro' in v) return NextResponse.json({ error: v.erro }, { status: 400 })
  const { data, error } = await createServerAdminClient().from('roteador_intencoes').insert(v.row).select('*').single()
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'Já existe uma intenção com esse nome' : error.message }, { status: 400 })
  return NextResponse.json({ intencao: data })
}

export async function PATCH(req: NextRequest) {
  if (!(await exigirUsuario())) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  const b = await req.json().catch(() => null)
  if (!b?.id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  const v = validarIntencao(b)
  if ('erro' in v) return NextResponse.json({ error: v.erro }, { status: 400 })
  const { error } = await createServerAdminClient().from('roteador_intencoes').update(v.row).eq('id', b.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  if (!(await exigirUsuario())) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })
  const { error } = await createServerAdminClient().from('roteador_intencoes').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
