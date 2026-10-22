export type Coluna = {
  id: string
  funil_id: string
  nome: string
  cor: string
  ordem: number
  ia_ativa_default: boolean
}

export type Familia = {
  id: string
  nome_responsavel: string
  telefone: string
  email: string | null
  origem: string | null
}

export type Lead = {
  id: string
  familia_id: string
  crianca_id: string | null
  coluna_id: string
  responsavel_id: string | null
  score: number
  temperatura: 'frio' | 'morno' | 'quente'
  temperatura_manual?: boolean
  ia_ativa: boolean
  followup_count?: number
  ultimo_followup_em?: string | null
  followup_status?: 'ativo' | 'esgotado'
  // Encerramento de atendimento: tira o lead do follow-up proativo, mas mantém a
  // Sara reativa (ela ainda responde se a família voltar). Null = follow-up normal.
  followup_encerrado_em?: string | null
  followup_encerrado_motivo?: string | null
  // Sara sugere encerrar (o gestor confirma no botão) — nunca silencia sozinha.
  sugestao_encerramento?: boolean
  sugestao_encerramento_em?: string | null
  sugestao_encerramento_motivo?: string | null
  sugestao_matricula?: boolean
  sugestao_matricula_em?: string | null
  cog_intencao?: string | null
  cog_emocao?: string | null
  cog_temperatura?: string | null
  cog_interesse?: number | null
  cog_urgencia?: number | null
  cog_probabilidade?: number | null
  cog_proxima_acao?: string | null
  cog_atualizado_em?: string | null
  tags: string[]
  motivo_perda: string | null
  proxima_acao: string | null
  data_proxima_acao: string | null
  entrou_coluna_em: string
  criado_em: string
  atualizado_em: string
  familia?: Familia
  crianca?: Crianca | null
}

export type Crianca = {
  id: string
  familia_id: string
  nome: string
  idade: number | null
  idade_meses: number | null
  serie_desejada: string | null
  periodo: 'matutino' | 'vespertino' | 'integral' | null
}

export type Mensagem = {
  id: string
  lead_id: string
  direcao: 'in' | 'out_humano' | 'out_ia'
  conteudo: string
  tipo_midia: string
  url_midia: string | null
  enviado_por: string | null
  whatsapp_message_id: string | null
  criado_em: string
  // Recibos de entrega (só faz sentido em mensagens de saída). O webhook Cloud e o
  // do Evolution atualizam por whatsapp_message_id: enviado → entregue → lido → falhou.
  status: 'enviado' | 'entregue' | 'lido' | 'falhou'
  erro_envio: string | null
  lida: boolean
  agente: string | null
  agente_origem: string | null
}
