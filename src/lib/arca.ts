// Cliente da Edge Function `salomao-atendimento` do Arca (projeto Supabase sgei).
// Contrato oficial (22/07/2026): identificar, financeiro, recado — header x-api-key.
// Reusa a mesma chave da integração SGEI (SGEI_API_KEY). O backend do Arca é quem
// decide o que pode ser revelado (trava de número único + 2º fator CPF) — o CRM
// nunca contorna essas travas pelo lado da conversa.

const ARCA_ENDPOINT =
  process.env.SALOMAO_API_URL ||
  'https://zdarztyghsnhbsusizko.supabase.co/functions/v1/salomao-atendimento'

export function arcaConfigurado(): boolean {
  return !!process.env.SGEI_API_KEY
}

async function arcaApi<T>(body: object): Promise<T> {
  const key = process.env.SGEI_API_KEY
  if (!key) throw new Error('SGEI_API_KEY não configurada no CRM')
  const r = await fetch(ARCA_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`Arca ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json() as Promise<T>
}

// -- identificar -------------------------------------------------------------
// identificado=false: número desconhecido OU casando com mais de um responsável.
// De propósito NÃO retorna nomes de crianças — só o primeiro nome do responsável.
export type ArcaIdentificar = {
  identificado: boolean
  primeiro_nome?: string
  tem_alunos?: boolean
}

export async function arcaIdentificar(whatsapp: string): Promise<ArcaIdentificar | null> {
  try {
    return await arcaApi<ArcaIdentificar>({ recurso: 'identificar', whatsapp })
  } catch (e) {
    console.error('[arca] identificar falhou:', e instanceof Error ? e.message : e)
    return null
  }
}

// -- financeiro --------------------------------------------------------------
// EXIGE cpf_prefixo (3 primeiros dígitos do CPF do responsável), conferido no
// backend. confirmado=false => NADA é revelado.
export type ArcaTitulo = {
  aluno: string
  descricao: string
  valor: number
  vencimento: string
  status: string
}

export type ArcaFinanceiro = {
  identificado: boolean
  confirmado: boolean
  primeiro_nome?: string
  titulos?: ArcaTitulo[]
  total_aberto?: number
  erro?: string
}

export async function arcaFinanceiro(
  whatsapp: string,
  cpfPrefixo: string,
  alunoId?: string
): Promise<ArcaFinanceiro | null> {
  try {
    const body: Record<string, string> = {
      recurso: 'financeiro',
      whatsapp,
      cpf_prefixo: cpfPrefixo,
    }
    if (alunoId) body.aluno_id = alunoId
    return await arcaApi<ArcaFinanceiro>(body)
  } catch (e) {
    console.error('[arca] financeiro falhou:', e instanceof Error ? e.message : e)
    return null
  }
}

// -- pix (Copia e Cola sob demanda) ------------------------------------------
// Mesma trava do financeiro: EXIGE cpf_prefixo (3 primeiros dígitos), conferido
// no backend. confirmado=false => nada é gerado. Um código por título em aberto.
export type ArcaPixItem = {
  aluno: string
  descricao: string
  valor: number
  vencimento: string
  copia_cola: string
  link: string | null
}

export type ArcaPix = {
  identificado: boolean
  confirmado: boolean
  primeiro_nome?: string
  pix?: ArcaPixItem[]
  erro?: string
}

export async function arcaPix(
  whatsapp: string,
  cpfPrefixo: string,
  alunoId?: string
): Promise<ArcaPix | null> {
  try {
    const body: Record<string, string> = { recurso: 'pix', whatsapp, cpf_prefixo: cpfPrefixo }
    if (alunoId) body.aluno_id = alunoId
    return await arcaApi<ArcaPix>(body)
  } catch (e) {
    console.error('[arca] pix falhou:', e instanceof Error ? e.message : e)
    return null
  }
}

// -- recado ------------------------------------------------------------------
// Registra solicitação na tabela atendimento_recados (status "novo") para a
// secretaria tratar dentro do Arca. Nunca lança (falha silenciosa com log).
export async function arcaRecado(
  whatsapp: string,
  texto: string,
  alunoId?: string
): Promise<boolean> {
  try {
    const body: Record<string, string> = { recurso: 'recado', whatsapp, texto }
    if (alunoId) body.aluno_id = alunoId
    const r = await arcaApi<{ ok: boolean }>(body)
    return r?.ok === true
  } catch (e) {
    console.error('[arca] recado falhou:', e instanceof Error ? e.message : e)
    return false
  }
}

// -- disparo de boletos (fila) ----------------------------------------------
// O Arca monta a fila (boleto ↔ aluno, mensagem, URL assinada). O CRM só
// consome e envia via Evolution. `url_boleto` é assinada e vale ~5 min — baixe
// e envie logo; se demorar, chame disparosPendentes de novo (gera URL nova).
export type ArcaDisparoItem = {
  id: string
  whatsapp: string // E.164, pronto para o Evolution
  nome_responsavel: string
  aluno: string
  referencia: string
  mensagem: string
  url_boleto: string
  nome_arquivo: string
}

export type ArcaDisparosPendentes = {
  pendentes: number
  items: ArcaDisparoItem[]
}

// Puxa a fila de disparos pendentes. Lança em erro (o chamador reporta).
export async function arcaDisparosPendentes(limite = 50): Promise<ArcaDisparosPendentes> {
  const r = await arcaApi<ArcaDisparosPendentes>({ recurso: 'disparos_pendentes', limite })
  return { pendentes: r?.pendentes ?? 0, items: Array.isArray(r?.items) ? r.items : [] }
}

// Confirma um disparo — sempre, sucesso ou falha. Idempotente no Arca.
// Nunca lança: uma confirmação perdida não deve derrubar o loop.
export async function arcaMarcarEnviado(id: string, sucesso: boolean, erro?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = { recurso: 'marcar_enviado', id, sucesso }
    if (!sucesso && erro) body.erro = erro.slice(0, 300)
    await arcaApi(body)
  } catch (e) {
    console.error('[arca] marcar_enviado falhou:', e instanceof Error ? e.message : e)
  }
}

// -- disparo de mensagens em massa (fila do "Disparo do Salomão") -------------
// O Arca resolve o responsável e o número na tela do SGEI; aqui cada item já
// vem com whatsapp em E.164, a mensagem do lote e URLs assinadas dos anexos
// (~5 min). O CRM envia pelo Evolution e chama marcarMensagemEnviada.
export type ArcaMensagemAnexo = {
  url: string // assinada, vale ~5 min — envie logo
  nome: string
  mime: string
}

export type ArcaMensagemItem = {
  id: string
  whatsapp: string // E.164, pronto para o Evolution
  mensagem: string
  anexos: ArcaMensagemAnexo[]
}

export type ArcaMensagensPendentes = {
  pendentes: number
  items: ArcaMensagemItem[]
}

// Puxa a fila de mensagens pendentes. Lança em erro (o chamador reporta).
export async function arcaMensagensPendentes(limite = 50): Promise<ArcaMensagensPendentes> {
  const r = await arcaApi<ArcaMensagensPendentes>({ recurso: 'mensagens_pendentes', limite })
  return { pendentes: r?.pendentes ?? 0, items: Array.isArray(r?.items) ? r.items : [] }
}

// Confirma um item da fila de mensagens — sempre, sucesso ou falha. Idempotente.
// Nunca lança: uma confirmação perdida não deve derrubar o loop.
export async function arcaMarcarMensagemEnviada(id: string, sucesso: boolean, erro?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = { recurso: 'marcar_mensagem_enviada', id, sucesso }
    if (!sucesso && erro) body.erro = erro.slice(0, 300)
    await arcaApi(body)
  } catch (e) {
    console.error('[arca] marcar_mensagem_enviada falhou:', e instanceof Error ? e.message : e)
  }
}
