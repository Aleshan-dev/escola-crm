# Fase 1 — Porte do umbilical SGEI (overlay pronto pra colar)

> **Data:** 2026-09-28 · Companheiro de [CUTOVER-FASE0-RUNBOOK.md](./CUTOVER-FASE0-RUNBOOK.md)
> **O que é:** o módulo `src/lib/sgei.ts` do sistema no ar portado 1:1 para o overlay do fork DeskcommCRM. Colar os dois arquivos abaixo no clone, adicionar as 4 envs, ligar no ponto de entrada de contato, rodar os testes.
> **Regra:** SGEI é **read-only** — o CRM só lê, nunca escreve. A lógica de normalização de celular + fallback por sufixo é provada em produção; **mantida verbatim de propósito.**

---

## Arquivo 1 — `lib/escola/sgei.ts`

```ts
import { createClient } from '@supabase/supabase-js'

// [escola-overlay] Integração read-only com o SGEI (Escola Guardiã).
// Banco SEPARADO do CRM — integração, NÃO unificação. O CRM só LÊ turmas/alunos/
// responsáveis/ocupação do SGEI; nunca escreve.
// Porte 1:1 de src/lib/sgei.ts do sistema no ar (escola-crm), mantido verbatim.
// Requer no ambiente: SGEI_SUPABASE_URL, SGEI_SUPABASE_SERVICE_KEY (leitura direta),
// SGEI_API_KEY (Edge Function crm-integracao) e, opcional, SGEI_API_URL.
export function createSgeiClient() {
  const url = process.env.SGEI_SUPABASE_URL
  const key = process.env.SGEI_SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error('SGEI não configurado: defina SGEI_SUPABASE_URL e SGEI_SUPABASE_SERVICE_KEY.')
  }
  return createClient(url, key, { auth: { persistSession: false } })
}

export function sgeiConfigurado(): boolean {
  return !!(process.env.SGEI_SUPABASE_URL && process.env.SGEI_SUPABASE_SERVICE_KEY)
}

// Integração via Edge Function do SGEI (contrato oficial, header x-api-key).
const SGEI_ENDPOINT =
  process.env.SGEI_API_URL || 'https://zdarztyghsnhbsusizko.supabase.co/functions/v1/crm-integracao'

export function sgeiApiConfigurado(): boolean {
  return !!process.env.SGEI_API_KEY
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sgeiApi<T = any>(body: object): Promise<T> {
  const key = process.env.SGEI_API_KEY
  if (!key) throw new Error('SGEI_API_KEY não configurada')
  const r = await fetch(SGEI_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`SGEI ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json() as Promise<T>
}

export type CheckLead = { ja_responsavel: boolean; nome_responsavel?: string; vinculo_ativo?: boolean }

// Identifica se o número já é responsável de aluno. Nunca lança (falha silenciosa).
export async function checkLead(whatsapp: string): Promise<CheckLead | null> {
  try {
    return await sgeiApi<CheckLead>({ recurso: 'check_lead', whatsapp })
  } catch (e) {
    console.error('[sgei] check_lead falhou:', e instanceof Error ? e.message : e)
    return null
  }
}

export type ResponsavelSgei = {
  ja_responsavel: boolean
  nome?: string | null
  vinculo_ativo?: boolean
  turma_id?: string | null
  turma_nome?: string | null
  aluno_nome?: string | null
}

// Normaliza um celular BR para 11 dígitos (DDD + 9 + 8). Reconstrói o 9º dígito
// quando o WhatsApp manda o número no formato antigo (sem o 9).
export function normalizarCelularBR(raw: string): string | null {
  let d = (raw || '').replace(/\D/g, '')
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2) // tira código do país
  if (d.length === 10) d = d.slice(0, 2) + '9' + d.slice(2) // DDD + 8 -> insere o 9
  if (d.length === 11) return d
  return d.length >= 11 ? d.slice(-11) : null
}

// Identificação de responsável na ENTRADA de um contato (leitura direta da base
// do SGEI). Replica check_lead e descobre a TURMA do aluno ativo, para posicionar
// o lead na coluna certa do funil de matriculados.
export async function identificarResponsavel(telefone: string): Promise<ResponsavelSgei | null> {
  if (!sgeiConfigurado()) return null
  const norm = normalizarCelularBR(telefone)
  if (!norm) return { ja_responsavel: false }
  try {
    const sgei = createSgeiClient()
    let { data: resp } = await sgei
      .from('responsaveis')
      .select('id, nome')
      .eq('celular_norm', norm)
      .limit(1)
      .maybeSingle()

    // Fallback: casa pelos últimos 8 dígitos, aceitando só se for único —
    // contorna variações residuais de DDD/9º dígito sem risco de falso positivo.
    if (!resp) {
      const suf8 = norm.slice(-8)
      const { data: r2 } = await sgei
        .from('responsaveis')
        .select('id, nome')
        .like('celular_norm', `%${suf8}`)
        .limit(2)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (r2 && r2.length === 1) resp = r2[0] as any
    }

    if (!resp) return { ja_responsavel: false }

    const { data: vinculos } = await sgei
      .from('aluno_responsavel')
      .select('alunos!inner(id, nome, status, turma_id, turmas(id, nome))')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('responsavel_id', (resp as any).id)

    let vinculo_ativo = false
    let turma_id: string | null = null
    let turma_nome: string | null = null
    let aluno_nome: string | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const v of (vinculos || []) as any[]) {
      const a = v.alunos
      if (a && a.status === 'ativo') {
        vinculo_ativo = true
        aluno_nome = a.nome ?? aluno_nome
        if (a.turma_id) {
          turma_id = a.turma_id
          turma_nome = a.turmas?.nome ?? null
          break // prefere um vínculo que já tenha turma definida
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const primeiroNome = ((resp as any).nome || '').split(' ')[0] || (resp as any).nome
    return { ja_responsavel: true, nome: primeiroNome, vinculo_ativo, turma_id, turma_nome, aluno_nome }
  } catch (e) {
    console.error('[sgei] identificarResponsavel falhou:', e instanceof Error ? e.message : e)
    return null
  }
}

// Ocupação/vagas por turma. Cache curto para não bater a cada mensagem.
export type OcupacaoTurma = { turma: string; capacidade: number; matriculados: number; vagas: number }
let _ocupDiretaCache: { at: number; data: OcupacaoTurma[] } | null = null
const OCUP_TTL_MS = 3 * 60 * 1000

export async function getOcupacaoDireta(): Promise<OcupacaoTurma[] | null> {
  if (!sgeiConfigurado()) return null
  if (_ocupDiretaCache && Date.now() - _ocupDiretaCache.at < OCUP_TTL_MS) return _ocupDiretaCache.data
  try {
    const sgei = createSgeiClient()
    const { data, error } = await sgei
      .from('get_ocupacao')
      .select('turma, capacidade, matriculados, vagas')
      .order('turma')
    if (error || !data) return _ocupDiretaCache?.data ?? null
    _ocupDiretaCache = { at: Date.now(), data: data as OcupacaoTurma[] }
    return data as OcupacaoTurma[]
  } catch (e) {
    console.error('[sgei] getOcupacaoDireta falhou:', e instanceof Error ? e.message : e)
    return _ocupDiretaCache?.data ?? null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ocupCache: { at: number; data: any } | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOcupacao(): Promise<any | null> {
  if (_ocupCache && Date.now() - _ocupCache.at < OCUP_TTL_MS) return _ocupCache.data
  try {
    const data = await sgeiApi({ recurso: 'ocupacao' })
    _ocupCache = { at: Date.now(), data }
    return data
  } catch (e) {
    console.error('[sgei] ocupacao falhou:', e instanceof Error ? e.message : e)
    return _ocupCache?.data ?? null
  }
}
```

## Arquivo 2 — `lib/escola/sgei.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { normalizarCelularBR } from './sgei'

describe('normalizarCelularBR', () => {
  it('tira o código do país 55', () => {
    expect(normalizarCelularBR('55 31 99999-8888')).toBe('31999998888')
  })
  it('reconstrói o 9º dígito em número de 10 dígitos', () => {
    expect(normalizarCelularBR('(31) 3333-4444')).toBe('31933334444')
  })
  it('mantém um número já normalizado (11 dígitos)', () => {
    expect(normalizarCelularBR('31999998888')).toBe('31999998888')
  })
  it('pega os últimos 11 dígitos quando vem lixo à esquerda', () => {
    expect(normalizarCelularBR('551131999998888')).toBe('31999998888')
  })
  it('retorna null quando é curto demais', () => {
    expect(normalizarCelularBR('123')).toBeNull()
  })
})
```

---

## Adaptações a conferir no clone (não são bugs, são pontos de encaixe)

1. **Multi-tenant.** O módulo lê as creds do SGEI de `process.env` (1 escola = 1 tenant, ok). Se um dia virar multi-tenant, mover as 4 creds para config por organização (o DeskcommCRM tem `tenant_integrations` para isso) em vez de env global.
2. **Loader de env.** Se o fork tiver um carregador de env tipado/validado (ex.: `lib/env.ts` ou schema em `lib/schemas/`), declarar `SGEI_*` lá também, senão o build pode reclamar de env não registrada.
3. **`lint:channels` / registro de fronteira.** O DeskcommCRM tem varreduras de fronteira (canais e identificadores que cruzam sistema). Este módulo fala com um sistema externo (SGEI) — rodar `pnpm lint:channels` e `pnpm gov:verify`; se o CI exigir, **declarar o endpoint `crm-integracao` no registro de fronteira** do repo.
4. **Cache em memória.** `_ocupCache`/`_ocupDiretaCache` são por-processo. Com múltiplos workers/replicas cada um tem o seu (aceitável: TTL 3 min, dados de ocupação). Se quiser cache compartilhado, trocar por Upstash Redis (já disponível na stack).
5. **Endpoint default hardcoded.** `SGEI_ENDPOINT` cai no projeto `zdarztyghsnhbsusizko` se `SGEI_API_URL` faltar — igual ao legado. Preferir sempre setar `SGEI_API_URL` explícito no `.env`.

## Ponto de encaixe (onde chamar)

Chamar `identificarResponsavel(telefone)` **na entrada de um contato novo** (mensagem inbound do WhatsApp que cria/atualiza `contacts`), para:
- marcar o contato como responsável (`ja_responsavel`, `nome`, `aluno_nome`);
- posicionar o lead na **coluna/série certa** do funil de matriculados usando `turma_id`/`turma_nome` (isso conecta com a Fase 4).

No fork, o ponto provável é o handler inbound (`app/api/v1/webhooks/meta/[token]` / `waha`, ou `lib/agent-engine/channel-adapter.ts`) e o serviço que cria contato/lead. **Confirmar o caminho exato no clone** — fica em `lib/escola/` só a lógica; a fiação chama a partir do core via esse gancho. E `getOcupacaoDireta()` alimenta a Sara com vagas por turma (Fase 2).

> ⚠️ **Onde gravar o vínculo:** o upstream **removeu** `crm_students` — não há mais tabela de aluno na main. Então o resultado de `identificarResponsavel` (aluno↔responsável, turma) é persistido no **modelo de escola do overlay**, que é criado como migrations na **Fase 4**. Na Fase 1, dá pra plugar a *leitura* (marcar responsável, ler ocupação) e deixar a *gravação* do vínculo para quando o modelo do overlay existir — ou criar já uma tabela mínima de vínculo no overlay se quiser antecipar.

## Verificação (Fase 1)

- [ ] `pnpm gov:verify` verde com os dois arquivos.
- [ ] Teste manual: telefone de um responsável real → `identificarResponsavel` devolve `nome`, `vinculo_ativo`, `turma_nome` **iguais ao legado** (comparar com o sistema no ar).
- [ ] Telefone desconhecido → `{ ja_responsavel: false }`, sem lançar.
- [ ] `getOcupacaoDireta()` devolve a lista de turmas com vagas (bater com o SGEI).
- [ ] SGEI fora do ar / envs ausentes → funções retornam `null`/fallback sem derrubar o inbound (falha silenciosa preservada).
