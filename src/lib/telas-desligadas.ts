// TELAS ANTIGAS DESLIGADAS (OK da Direção em 19/11/2026). O CRM agora é só o MOTOR
// (API, webhooks, crons, Sara/Salomão); as telas moram no ARCA (Comercial). Cada tela
// antiga redireciona para a equivalente (mapa em docs/UNIFICACAO-CRM.md do ARCA).
// Ficam no ar só o que precisa deste domínio: login/callback (sessão p/ as telas abaixo),
// conectar o Google e o WhatsApp oficial (OAuth da Meta/Google só aceita este domínio),
// privacidade/termos (exigidos pela Meta) e sem-acesso.

export const ARCA = 'https://arca.pequenosguardioes.com'

const TELAS_QUE_FICAM = [
  '/login',
  '/auth',
  '/configuracoes/integracoes',
  '/configuracoes/whatsapp-oficial',
  '/privacy',
  '/termos',
  '/sem-acesso',
]

// Ordem importa: o primeiro prefixo que casar vence (específico antes do genérico).
const MAPA_ARCA: [string, string][] = [
  ['/inicio', '/comercial/painel'],
  ['/kanban', '/comercial/funil'],
  ['/chat', '/comercial/conversas'],
  ['/pendentes', '/comercial/atendimentos-pendentes'],
  ['/casos', '/comercial/casos'],
  ['/agendamentos', '/comercial/agenda-de-visitas'],
  ['/arquivados', '/comercial/leads-arquivados'],
  ['/anuncios', '/comercial/anuncios'],
  ['/auditoria', '/comercial/auditoria-sara'],
  ['/treinar', '/comercial/treinar-sara'],
  ['/configuracoes/sara', '/comercial/agentes-ia'],
  ['/configuracoes/salomao/auditoria', '/comercial/ia-avancado'],
  ['/configuracoes/salomao', '/comercial/agentes-ia'],
  ['/configuracoes/series', '/comercial/cadastros'],
  ['/configuracoes/turnos', '/comercial/cadastros'],
  ['/configuracoes/horarios-visita', '/comercial/cadastros'],
  ['/configuracoes/motivos', '/comercial/cadastros'],
  ['/configuracoes/origens', '/comercial/cadastros'],
  ['/configuracoes/metas', '/comercial/cadastros'],
  ['/configuracoes/investimento', '/comercial/cadastros'],
  ['/configuracoes/followup', '/comercial/ia-avancado'],
  ['/configuracoes/roteador', '/comercial/ia-avancado'],
  ['/configuracoes/maestro', '/comercial/ia-avancado'],
  ['/configuracoes/memoria', '/comercial/ia-avancado'],
  ['/configuracoes', '/comercial/motor-whatsapp'],
  ['/comunicacao', '/pedagogico/turmas'],
  ['/responsaveis', '/comercial/funil'],
]

const ehDaRota = (p: string, base: string) => p === base || p.startsWith(base + '/')

/** Destino no ARCA de uma tela antiga, ou null se a rota continua no CRM. */
export function destinoNoArca(pathname: string): string | null {
  if (pathname.startsWith('/api') || pathname.startsWith('/_next')) return null
  if (TELAS_QUE_FICAM.some((b) => ehDaRota(pathname, b))) return null
  if (pathname === '/') return `${ARCA}/comercial/funil`
  const par = MAPA_ARCA.find(([base]) => ehDaRota(pathname, base))
  // Arquivo estático (ícone, imagem, manifest…) não é tela.
  if (!par && /\.[a-z0-9]+$/i.test(pathname)) return null
  return `${ARCA}${par ? par[1] : '/comercial/funil'}`
}
