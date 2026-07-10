'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import type { Coluna } from '@/lib/types'
import { X, Loader2 } from 'lucide-react'

const inputCls =
  'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400'

export function NewLeadModal({
  colunas,
  escolherColuna = false,
  onClose,
  onCreated,
}: {
  colunas: Coluna[]
  escolherColuna?: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const supabase = createClient()
  const [nome, setNome] = useState('')
  const [telefone, setTelefone] = useState('')
  const [email, setEmail] = useState('')
  const [criancaNome, setCriancaNome] = useState('')
  const [idade, setIdade] = useState('')
  const [saving, setSaving] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const colunasOrdenadas = [...colunas].sort((a, b) => a.ordem - b.ordem)
  const primeiraColuna = colunasOrdenadas[0]
  const [colunaId, setColunaId] = useState<string>('')
  const colunaEscolhida = colunaId || primeiraColuna?.id

  async function salvar() {
    setErro(null)
    if (!nome.trim() || !telefone.trim()) {
      setErro('Responsável e telefone são obrigatórios.')
      return
    }
    if (!primeiraColuna) {
      setErro('Nenhuma coluna encontrada no funil.')
      return
    }
    setSaving(true)
    try {
      const { data: familia, error: errFam } = await supabase
        .from('familias')
        .insert({
          nome_responsavel: nome.trim(),
          telefone: telefone.trim(),
          email: email.trim() || null,
        })
        .select('id')
        .single()
      if (errFam || !familia) throw new Error(errFam?.message || 'Falha ao criar família')

      let criancaId: string | null = null
      if (criancaNome.trim()) {
        const { data: crianca, error: errCri } = await supabase
          .from('criancas')
          .insert({
            familia_id: familia.id,
            nome: criancaNome.trim(),
            idade: idade.trim() ? Number(idade) : null,
          })
          .select('id')
          .single()
        if (errCri) throw new Error(errCri.message)
        criancaId = crianca?.id ?? null
      }

      const colObj = colunasOrdenadas.find((c) => c.id === colunaEscolhida)
      const { error: errLead } = await supabase.from('leads').insert({
        familia_id: familia.id,
        crianca_id: criancaId,
        coluna_id: colunaEscolhida,
        // Respeita o padrão de IA da coluna (turmas do funil Matriculados = Sara off).
        ia_ativa: colObj ? colObj.ia_ativa_default : true,
      })
      if (errLead) throw new Error(errLead.message)

      onCreated()
      onClose()
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao criar lead')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 p-5">
          <h2 className="text-lg font-semibold">Novo lead</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Fechar">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Responsável *</span>
            <input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} placeholder="Nome do responsável" />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">Telefone *</span>
            <input value={telefone} onChange={(e) => setTelefone(e.target.value)} className={inputCls} placeholder="5589..." />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-500">E-mail</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="opcional" />
          </div>
          {escolherColuna && colunasOrdenadas.length > 0 && (
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">Turma</span>
              <select value={colunaEscolhida} onChange={(e) => setColunaId(e.target.value)} className={inputCls}>
                {colunasOrdenadas.map((c) => (
                  <option key={c.id} value={c.id}>{c.nome}</option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">Criança</span>
              <input value={criancaNome} onChange={(e) => setCriancaNome(e.target.value)} className={inputCls} placeholder="opcional" />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-500">Idade</span>
              <input value={idade} onChange={(e) => setIdade(e.target.value)} className={inputCls} placeholder="opcional" inputMode="numeric" />
            </div>
          </div>
          {erro && <p className="text-sm text-red-600">{erro}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 p-4">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
            Cancelar
          </button>
          <button
            onClick={salvar}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Criar lead
          </button>
        </div>
      </div>
    </div>
  )
}
