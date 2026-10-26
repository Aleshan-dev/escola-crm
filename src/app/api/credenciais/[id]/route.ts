import { NextRequest, NextResponse } from 'next/server'
import { createServerAdminClient } from '@/lib/supabase-server'
import { validarCredencial, type Provedor } from '@/lib/ia-credenciais'

// DELETE: remove a credencial (desvinculando dos agentes antes).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createServerAdminClient()
  const { data: cfg } = await db.from('config_ia').select('sara_credencial_id, salomao_credencial_id').eq('id', 1).maybeSingle()
  const patch: Record<string, null> = {}
  if (cfg?.sara_credencial_id === id) patch.sara_credencial_id = null
  if (cfg?.salomao_credencial_id === id) patch.salomao_credencial_id = null
  if (Object.keys(patch).length) await db.from('config_ia').update(patch).eq('id', 1)
  const { error } = await db.from('ia_credenciais').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// POST: revalida a credencial (refaz o models.list).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createServerAdminClient()
  const { data: cred } = await db.from('ia_credenciais').select('provedor, api_key, base_url').eq('id', id).maybeSingle()
  if (!cred) return NextResponse.json({ error: 'Credencial não encontrada' }, { status: 404 })
  const v = await validarCredencial(cred.provedor as Provedor, cred.api_key, cred.base_url)
  await db.from('ia_credenciais').update({ validada: v.ok, erro_validacao: v.erro ?? null, atualizado_em: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ validada: v.ok, erro_validacao: v.erro ?? null })
}
