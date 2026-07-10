/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server'
import { createSgeiClient, sgeiConfigurado } from '@/lib/sgei'

export const dynamic = 'force-dynamic'

// Monta o funil "Comunicação com os pais": colunas = turmas, cards = alunos (com responsáveis).
export async function GET() {
  if (!sgeiConfigurado()) {
    return NextResponse.json({ ok: false, erro: 'SGEI não configurado no CRM.' }, { status: 400 })
  }
  try {
    const sgei = createSgeiClient()
    const [turmasRes, alunosRes, vinculosRes, respRes] = await Promise.all([
      sgei.from('turmas').select('id, nome, curso, capacidade, faixa_etaria').order('nome'),
      sgei.from('alunos').select('id, nome, celular, turma_id, turno, status').eq('status', 'ativo'),
      sgei.from('aluno_responsavel').select('aluno_id, responsavel_id'),
      sgei.from('responsaveis').select('id, nome, celular, responsavel_financeiro'),
    ])

    const erro = turmasRes.error || alunosRes.error || vinculosRes.error || respRes.error
    if (erro) {
      return NextResponse.json({ ok: false, erro: erro.message }, { status: 500 })
    }

    const respById = new Map<string, any>((respRes.data || []).map((r: any) => [r.id, r]))
    const respPorAluno = new Map<string, any[]>()
    for (const v of vinculosRes.data || []) {
      const r = respById.get((v as any).responsavel_id)
      if (!r) continue
      const arr = respPorAluno.get((v as any).aluno_id) || []
      arr.push({ nome: r.nome, celular: r.celular, financeiro: r.responsavel_financeiro })
      respPorAluno.set((v as any).aluno_id, arr)
    }

    const alunosPorTurma = new Map<string, any[]>()
    for (const a of alunosRes.data || []) {
      const card = {
        id: (a as any).id,
        nome: (a as any).nome,
        celular: (a as any).celular,
        turno: (a as any).turno,
        status: (a as any).status,
        responsaveis: respPorAluno.get((a as any).id) || [],
      }
      const key = (a as any).turma_id || 'sem_turma'
      const arr = alunosPorTurma.get(key) || []
      arr.push(card)
      alunosPorTurma.set(key, arr)
    }

    const colunas = (turmasRes.data || []).map((t: any) => ({
      id: t.id,
      nome: t.nome,
      curso: t.curso,
      capacidade: t.capacidade,
      faixa_etaria: t.faixa_etaria,
      ocupacao: (alunosPorTurma.get(t.id) || []).length,
      alunos: alunosPorTurma.get(t.id) || [],
    }))

    const semTurma = alunosPorTurma.get('sem_turma') || []

    return NextResponse.json({ ok: true, colunas, semTurma })
  } catch (e) {
    return NextResponse.json({ ok: false, erro: e instanceof Error ? e.message : 'erro' }, { status: 500 })
  }
}
