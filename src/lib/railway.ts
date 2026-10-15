// Cliente mínimo da API pública do Railway (GraphQL), usado só para reiniciar
// o serviço do Evolution quando ele cai.
//
// Docs: https://docs.railway.com/integrations/api
// Endpoint e mutations conferidos em 29/07/2026.
//
// Secrets necessários (Vercel):
//   RAILWAY_API_TOKEN      token de conta ou workspace
//   RAILWAY_SERVICE_ID     id do serviço do Evolution
//   RAILWAY_ENVIRONMENT_ID id do environment (production)
// Todos os três aparecem no Railway com Cmd/Ctrl+K dentro do projeto.

const ENDPOINT = 'https://backboard.railway.com/graphql/v2'

const TOKEN = process.env.RAILWAY_API_TOKEN
const SERVICE_ID = process.env.RAILWAY_SERVICE_ID
const ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID

export function railwayConfigurado(): boolean {
  return !!(TOKEN && SERVICE_ID && ENVIRONMENT_ID)
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  })
  const texto = await r.text()
  if (!r.ok) throw new Error(`Railway HTTP ${r.status}: ${texto.slice(0, 300)}`)

  let json: { data?: T; errors?: { message: string }[] }
  try {
    json = JSON.parse(texto)
  } catch {
    throw new Error(`Railway devolveu resposta não-JSON: ${texto.slice(0, 200)}`)
  }
  // Erro de GraphQL vem com HTTP 200. Sem este check, falha silenciosa de novo.
  if (json.errors?.length) throw new Error(`Railway GraphQL: ${json.errors.map((e) => e.message).join('; ')}`)
  if (!json.data) throw new Error('Railway GraphQL: resposta sem data')
  return json.data
}

type DeploymentsResp = {
  deployments: { edges: { node: { id: string; status: string; createdAt: string } }[] }
}

/** Id do deployment ativo (SUCCESS) mais recente do serviço. */
async function deploymentAtivo(): Promise<{ id: string; status: string } | null> {
  const data = await gql<DeploymentsResp>(
    `query($serviceId: String!, $environmentId: String!) {
       deployments(
         first: 1
         input: { serviceId: $serviceId, environmentId: $environmentId }
       ) { edges { node { id status createdAt } } }
     }`,
    { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID }
  )
  const node = data.deployments?.edges?.[0]?.node
  return node ? { id: node.id, status: node.status } : null
}

/**
 * Reinicia o deployment ativo do Evolution SEM rebuild.
 * Devolve o id reiniciado para registro no alerta.
 */
export async function railwayRestartEvolution(): Promise<{ deploymentId: string; statusAnterior: string }> {
  if (!railwayConfigurado()) {
    throw new Error(
      'Railway não configurado: faltam RAILWAY_API_TOKEN, RAILWAY_SERVICE_ID ou RAILWAY_ENVIRONMENT_ID'
    )
  }

  const dep = await deploymentAtivo()
  if (!dep) throw new Error('Nenhum deployment encontrado para o serviço do Evolution')

  await gql<{ deploymentRestart: boolean }>(
    `mutation($id: String!) { deploymentRestart(id: $id) }`,
    { id: dep.id }
  )

  return { deploymentId: dep.id, statusAnterior: dep.status }
}
