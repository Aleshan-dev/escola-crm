# Maestro Guardião + roteador de intenção (escola-crm)

> Atualização de 2026-10-15. Reativação do escola-crm legado com o supervisor de
> política (Maestro) e o roteador de agente explícitos. Tudo **desligado por
> padrão** — ligar é opt-in por variável de ambiente.

## O que é

- **Maestro Guardião** (`src/lib/maestro/politica.ts`): função pura que decide,
  ANTES de qualquer agente, se a IA responde e por qual rota. Precedência:
  `opt-out` → `atendimento humano forçado` → `IA pausada` → escolha do agente.
- **Roteador** (`src/lib/roteador/decidir.ts`): escolhe o agente de forma
  **determinística** — matriculado (SGEI) + Salomão ligado → Salomão; matriculado
  sem Salomão → humano; lead novo → Sara. Sem chamada de IA. Fallback seguro =
  humano (nunca silêncio nem ação comercial indevida).
- **Opt-out** (`src/lib/maestro/opt-out.ts`): detecta pedido de parar (PT),
  conservador. Pausa a IA e grava `familias.opt_out_em`.
- **Validação de saída** (`src/lib/maestro/validar-resposta.ts`): confere o texto
  do agente antes de enviar (promessa de desconto/bolsa/convênio, valor monetário
  sem preço oficial, fatos proibidos). **Modo sombra por padrão** — só registra.

Tudo é consumido num ponto só: `processarMensagemRecebida` em
`src/lib/atendimento.ts` (o funil comum a todos os webhooks). O roteamento
determinístico que já existia embutido foi **preservado** — a decisão agora é
explícita e testável, sem mudar o resultado quando as flags estão off.

## Flags (variáveis de ambiente — sem migration)

| Variável | Default | Efeito |
|---|---|---|
| `MAESTRO_ATIVO` | *(off)* | `true` liga o gate de opt-out e o log de decisão. Off ⇒ rota idêntica à de sempre. |
| `VALIDACAO_SAIDA_MODO` | `log` | `off` desliga; `log` (sombra) só registra o que vetaria; `ativo` reservado (ver abaixo). |

> `ativo` (bloqueio real da resposta) **ainda não bloqueia** — precisa da lista de
> fatos oficiais do proprietário e do tratamento de registro/transbordo do balão
> vetado. Até lá, comporta-se como `log`.

## Banco (opcional, só para LIGAR)

`docs/sql/2026-10-15-maestro-roteador.sql` — aditiva, **não aplicada**. Necessária
só com `MAESTRO_ATIVO=true` (coluna `familias.opt_out_em` + tabela
`roteador_decisoes`). Sem ela, opt-out persistente e log degradam em silêncio.

## Como ligar (quando o proprietário decidir)

1. Aplicar o SQL acima no Supabase do escola-crm.
2. Setar `MAESTRO_ATIVO=true` na Vercel.
3. Observar `roteador_decisoes` e os logs `[maestro/validacao]` por alguns dias
   (modo sombra) para medir falso-positivo antes de pensar em `ativo`.

## Rollback

Remover as variáveis de ambiente (`MAESTRO_ATIVO`, `VALIDACAO_SAIDA_MODO`) volta
ao comportamento legado na hora — o código com flags off é idêntico ao de antes.
A migration é aditiva; pode ficar no banco sem efeito.

## Decisões pendentes do proprietário

1. **Lista de fatos fixos + regra de preço/vaga** para a validação de saída (ex.:
   preço oficialmente liberado? natação/piscina? bolsas?). Sem isso o gate fica em
   sombra.
2. Manter o **classificador de intenção por LLM desligado** (recomendado — há só 2
   agentes, separados por vínculo SGEI; interface documentada como futura).

## Testes

`src/lib/maestro/*.test.ts` e `src/lib/roteador/*.test.ts` — política (precedência
e paridade com o legado), opt-out (PT, acentos, falsos positivos), roteador e
validação de saída. Rodar: `npm test`.

## Classificador de intenção (desde 21/10/2026)

Camada opcional por cima da guarda, no estilo do roteador do DeskcommCRM, adaptada:
o escola-crm tem uma regra dura (vínculo SGEI → Salomão; família nova → Sara) que o
classificador **não** pode quebrar.

- **Tela:** `/configuracoes/roteador` (ligar/desligar, credencial, modelo, confiança mínima,
  histórico de contexto, intenções e o painel **Testar classificação**), mais
  `/configuracoes/roteador/decisoes`.
- **Código:**
  - `src/lib/roteador/classificador.ts`: prompt + leitura do JSON (puro); `classificarIntencao`;
  - `resolver.ts`: `resolverRota` (puro);
  - `turno.ts`: config, contexto e o efeito `encaminharParaHumano`.
  - Ligado em `processarMensagemRecebida` logo após `decidirPolitica`.
- **Banco:** `crm.roteador_config` (1 linha, `classificador_ligado=false` por padrão),
  `crm.roteador_intencoes` (5 sementes) e as colunas novas `intencao`/`confianca`/`resultado`
  em `roteador_decisoes`. SQL em `docs/sql/2026-10-21-roteador-classificador.sql`.
- **O que o classificador pode fazer:** só **manter** o agente da guarda ou **encaminhar para
  humano**. O encaminhamento acontece quando a intenção tem agente `humano` e a confiança passa
  do mínimo. O efeito é o do transbordo da Sara: `precisa_atendimento_humano` + `ia_ativa=false`
  + aviso ao gestor, uma vez só (update condicional).
  - Se a intenção apontar outro agente de IA, o resultado é `vetado_guarda` e fica registrado.
    Exemplo: "matrícula" vinda de uma família matriculada.
  - Falha, `none` ou confiança baixa: vale a guarda.
- **Diferenças para o Deskcomm:**
  - Não há troca de agente por intenção. O "sticky" é estrutural (o agente vem do estado da
    família), então os campos `sticky` e `fallback` não existem.
  - Não há funil/etapa de destino por intenção: a Sara já move o card.
  - O mínimo de confiança **é** editável na tela.
- **Custo:** com o classificador ligado, é uma chamada de IA por mensagem recebida que a IA
  responderia. Mensagens de leads pausados ou em atendimento humano não são classificadas.
- **Fora do escopo agora:** irmão de aluno matriculado querendo matricular outro filho
  (Sara para matriculado). Hoje a guarda veta; isso exige uma decisão de produto.

## Versões da Sara e do Salomão (desde 21/10/2026)

Nome, modelo, credencial, "informa preço" e prompt (Sara) e modelo, credencial,
preâmbulo e canais de pagamento (Salomão) são versionados em `crm.agente_versoes`
(SQL: `docs/sql/2026-10-21-agente-versoes.sql`; regras: `src/lib/agente-versoes/`).

- Editar em /configuracoes/sara ou /salomao grava **rascunho** — produção não muda.
- "Testar antes de publicar" gera a resposta para a conversa de um lead real com a
  edição atual (opcionalmente lado a lado com a do ar). Não envia nada; chama a IA.
- **Publicar** cria vN (função `crm.publicar_agente_versao`, atômica) e reflete em
  `config_ia`; quem lê (`sara.ts`, `salomao.ts`, `ia-credenciais.ts`) não mudou.
- Aba **Histórico**: diff de cada versão com a anterior e "Voltar para esta versão"
  (republica o snapshot antigo como vN+1; o histórico nunca é reescrito).
- O Maestro (`agente_prompt` / `agente_modelo`) agora **gera rascunho** em vez de
  escrever em `config_ia`; o gestor publica na tela do agente.
- Fora do versionamento (efeito imediato): `salomao_ativo` (kill switch) e a base de conhecimento.
- v1 de cada agente = configuração que estava em produção na migração.
