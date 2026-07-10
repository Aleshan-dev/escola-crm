/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { useEffect, useState } from 'react'
import { Loader2, Phone, MessageCircle, GraduationCap, Users } from 'lucide-react'

type Responsavel = { nome: string; celular: string | null; financeiro: boolean }
type Aluno = { id: string; nome: string; celular: string | null; turno: string | null; status: string; responsaveis: Responsavel[] }
type Turma = { id: string; nome: string; curso: string; capacidade: number; faixa_etaria: string | null; ocupacao: number; alunos: Aluno[] }

// Limpa o número e monta o link do WhatsApp
function waLink(celular: string | null): string | null {
  if (!celular) return null
  let d = celular.replace(/\D/g, '')
  if (!d) return null
  if (!d.startsWith('55')) d = '55' + d
  return `https://wa.me/${d}`
}

function CardAluno({ a }: { a: Aluno }) {
  const resp = a.responsaveis.find((r) => r.financeiro) || a.responsaveis[0]
  const tel = resp?.celular || a.celular
  const link = waLink(tel)
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-2.5 shadow-sm">
      <div className="text-sm font-medium truncate">{a.nome}</div>
      {resp && <div className="text-xs text-slate-500 truncate">Resp.: {resp.nome}</div>}
      <div className="mt-1.5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
          <Phone className="w-3 h-3" /> {tel || '—'}
        </span>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-green-600 hover:text-green-700"
            title="Abrir conversa no WhatsApp"
          >
            <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
          </a>
        )}
      </div>
    </div>
  )
}

export function FunilMatriculados() {
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [colunas, setColunas] = useState<Turma[]>([])
  const [semTurma, setSemTurma] = useState<Aluno[]>([])

  useEffect(() => {
    fetch('/api/sgei/comunicacao')
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) {
          setColunas(j.colunas || [])
          setSemTurma(j.semTurma || [])
        } else {
          setErro(j?.erro || 'Falha ao carregar')
        }
      })
      .catch(() => setErro('Falha de conexão'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-72 text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando turmas...
      </div>
    )
  }

  if (erro) {
    return (
      <div className="m-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <div className="font-medium">Não foi possível carregar os matriculados do SGEI.</div>
        <div className="mt-1 text-amber-700">{erro}</div>
        <div className="mt-2 text-xs text-amber-700">
          Configure no CRM (Vercel → Environment Variables) as chaves <code>SGEI_SUPABASE_URL</code> e{' '}
          <code>SGEI_SUPABASE_SERVICE_KEY</code> (painel do Supabase do SGEI → Settings → API) e refaça o deploy.
        </div>
      </div>
    )
  }

  const totalMatriculados = colunas.reduce((s, t) => s + t.ocupacao, 0) + semTurma.length

  return (
    <div className="overflow-x-auto p-4">
      <div className="mb-3 px-1 text-xs text-slate-500">
        {totalMatriculados} matriculado(s) em {colunas.length} turma(s) — dados do SGEI (Escola Guardiã).
      </div>
      <div className="flex gap-3 min-w-max items-start">
        {colunas.map((t) => {
          const lotada = t.ocupacao >= t.capacidade
          return (
            <div key={t.id} className="w-[260px] flex-shrink-0 bg-slate-100 rounded-xl p-2.5">
              <div className="flex items-center justify-between mb-2 px-1">
                <div className="flex items-center gap-2 min-w-0">
                  <GraduationCap className="w-4 h-4 text-slate-500 flex-shrink-0" />
                  <span className="text-sm font-medium truncate">{t.nome}</span>
                </div>
                <span
                  className={`text-[11px] rounded-full px-2 py-0.5 font-medium ${
                    lotada ? 'bg-red-100 text-red-700' : 'bg-white border border-slate-200 text-slate-600'
                  }`}
                  title="Matriculados / capacidade"
                >
                  {t.ocupacao}/{t.capacidade}
                </span>
              </div>
              <div className="space-y-2">
                {t.alunos.map((a) => (
                  <CardAluno key={a.id} a={a} />
                ))}
                {t.alunos.length === 0 && (
                  <div className="text-center text-xs text-slate-400 py-6 border border-dashed border-slate-300 rounded-lg">
                    Sem matriculados
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {semTurma.length > 0 && (
          <div className="w-[260px] flex-shrink-0 bg-slate-100 rounded-xl p-2.5">
            <div className="flex items-center gap-2 mb-2 px-1">
              <Users className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium text-slate-500">Sem turma</span>
              <span className="text-[11px] bg-white border border-slate-200 rounded-full px-2 py-0.5 text-slate-600">{semTurma.length}</span>
            </div>
            <div className="space-y-2">
              {semTurma.map((a) => (
                <CardAluno key={a.id} a={a} />
              ))}
            </div>
          </div>
        )}

        {colunas.length === 0 && semTurma.length === 0 && (
          <div className="text-sm text-slate-400 p-8">Nenhuma turma encontrada no SGEI.</div>
        )}
      </div>
    </div>
  )
}
