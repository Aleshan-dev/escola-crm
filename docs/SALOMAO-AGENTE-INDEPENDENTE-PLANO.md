# Salomão — Plano de Independência da Sara

*Elaborado em 03/09/2026 · Plano detalhado (nada aplicado ainda) · Projeto Supabase `sgei` (`zdarztyghsnhbsusizko`)*

Este documento é o **plano-primeiro** aprovado pelo gestor para transformar o
Salomão num agente independente da Sara, nos quatro eixos: **(A)** identidade nos
dados, **(B)** robustez operacional, **(C)** auditoria própria, **(D)** régua de
cobrança. Cada mudança marca claramente se roda no **CRM** (precisa deploy
`npx vercel --prod`), no **Arca/SGEI** (deploy de Edge Function) ou é só **banco**
(vai ao ar na hora via migração no schema `crm`).

---

## 0. Onde o Salomão realmente vive (descoberta de 03/09)

O Salomão **não é um módulo** — é um agente distribuído por **dois repositórios
que compartilham um único projeto Supabase** (`zdarztyghsnhbsusizko`), em dois
schemas:

| Camada | Repo / pasta | Schema | O que faz | Acoplamento com a Sara |
|---|---|---|---|---|
| **Conversa reativa** | `CRM Escola` (este) | `crm` | `salomao.ts` (persona + fluxo), `atendimento.ts` (roteamento), `salomao-dispatch.ts` (drena filas) | **Alto** — vive dentro do fluxo da Sara |
| **Cérebro financeiro** | `SGEI- Escola Guardiã` (Arca) | `public` | `salomao-atendimento` (identificar/financeiro/pix/recado), `regua-cobranca-run` (motor da régua), PagBank | **Nenhum** — a Sara não existe aqui |

**Conclusão que redireciona o trabalho:** no lado do Arca o Salomão **já é
totalmente independente** da Sara. Todo o acoplamento com a Sara está **no lado do
CRM** — roteador compartilhado, `out_ia` compartilhado, config compartilhada,
trava de concorrência compartilhada. **Os quatro eixos são, na prática, trabalho
de CRM.**

### Descoberta grande: a régua de cobrança (Eixo D) já está no ar

`regua-cobranca-run` (v4) roda **diariamente** e está **ativa**:

- `regua_config.ativa = true`; última rodada **hoje, 03/09/2026 14:00 UTC**.
- **5 regras ativas**: D-3, D0, D+1, D+7, D+15 (exatamente o desenho do doc de
  inadimplência), com templates LGPD-safe (`{primeiro_nome}`, `{descricao}`,
  `{aluno}`, `{valor}`, `{vencimento}` — sem dado individual do menor além do
  necessário; detalhe financeiro só sai depois do 2º fator do CPF na conversa).
- **17 envios** registrados; 53 títulos em aberto, 0 vencidos hoje (a base segue
  saudável, como o doc previu).
- Fluxo: `regua-cobranca-run` enfileira em `public.disparos_fila` → aciona o CRM
  (`event: dispatch_mensagens`) → o CRM drena via `drenarMensagensSalomao`
  ([salomao-dispatch.ts](../src/lib/salomao-dispatch.ts)) → Evolution. **A mesma
  fila e o mesmo pipeline que os comunicados em massa.**

Ou seja: **o "agente de cobrança" não está por construir — está operando.** O que
falta no Eixo D não é motor; é *identidade e observabilidade* no CRM (a régua cai
como `out_ia` anônimo) e *fechar o loop conversacional* quando a família responde.

---

## Eixo A — Identidade nos dados *(alicerce; baixo risco)*

**Problema.** No banco vivo há **1.096 mensagens `out_ia`** sem distinção entre
Sara e Salomão. Sem carimbo, é impossível auditar o Salomão, e toda métrica de
"IA" mistura captação com cobrança/atendimento a matriculados.

> **Correção (03/09):** `mensagens.enviado_por` **é `uuid`** (atribuição de
> usuário, nunca preenchido) — NÃO serve de rótulo de agente. Criamos a coluna
> **`crm.mensagens.agente text`** (`'sara' | 'salomao' | 'humano'`; `null` em
> `in`) para o carimbo. Uma primeira tentativa carimbando `enviado_por` com
> string quebrou os inserts em produção por alguns minutos (sem tráfego na
> janela → sem perda de log); corrigido no redeploy seguinte.

**Os 4 pontos de escrita de saída do Salomão no CRM** (todos gravam `out_ia` sem
carimbo hoje):

1. [salomao.ts `enviarERegistrar`](../src/lib/salomao.ts) — conversa reativa.
2. [disparos.ts:72 `registrarDisparoNoChat`](../src/lib/disparos.ts) — régua + comunicados em massa.
3. [boletos.ts:117 `registrarBoletoNoChat`](../src/lib/boletos.ts) — disparo de boletos.
4. [atendimento.ts:518](../src/lib/atendimento.ts) — saída da **Sara** (recebe `'sara'`).

**Mudanças**

- **[Banco] ✅ feito** — coluna `crm.mensagens.agente text`
  (`'sara' | 'salomao' | 'humano'`; `null` em `in`).
- **[CRM] ✅ feito** — `agente` preenchido em cada insert:
  - `salomao.ts` e as 2 funções de disparo → `'salomao'`.
  - `atendimento.ts` (saída da Sara) → `'sara'`.
  - `registrarMensagemManual` (out_humano) → `'humano'`.
- **[Banco] Backfill histórico ✅ feito** (heurística, uma vez): `out_humano`→
  `'humano'`; `out_ia` com marcador de boleto (`📎 Boleto enviado —…`)→`'salomao'`;
  `out_ia` de leads cuja família tem `ja_responsavel = true`→`'salomao'`; o
  restante das `out_ia`→`'sara'`. Resultado: 307 `salomao` / 789 `sara` / 217
  `humano`. **Precisão ~95%+** no histórico; o carimbo em tempo real é exato
  daqui pra frente.

**Deploy.** Migração de backfill vai ao ar na hora; o carimbo em tempo real
precisa do `npx vercel --prod`. Ordem: **deploy do código primeiro** (para não
gerar mais `out_ia` anônimo), **depois** o backfill.

**Rollback.** Trivial — `agente` é aditivo; nada depende dele até o Eixo C.

**Status: ✅ A entregue e no ar (03/09).**

---

## Eixo B — Robustez operacional

### B1. Trava de concorrência (mutex) para o Salomão — *corrige bug real*

**Problema.** O ramo da Sara passa pelo mutex `tentarTravarResposta`
([atendimento.ts:467](../src/lib/atendimento.ts)); o ramo do Salomão
([atendimento.ts:441–457](../src/lib/atendimento.ts)) **não** — só o debounce de
15s o protege. É a mesma classe de bug que duplicou a mensagem do Yuri em 04/09.
O Salomão está **mais exposto** que a Sara, e ainda faz efeitos colaterais
sensíveis (gera PIX, registra recado).

**Mudança [CRM]. ✅ feito** — a chamada `processarMensagemSalomao` agora está no
mesmo `tentarTravarResposta`/`liberarTravaResposta` (try/finally) da Sara, com o
guard de "já respondida". Como o Salomão já junta os balões da rajada
(`juntarBaloesRecebidos`), o mutex fecha a última fresta de concorrência.
**Status: ✅ no ar (03/09).**

### B2. Config própria (persona + modelo editáveis sem deploy)

**Problema.** A persona inteira do Salomão está **hardcoded** em
[salomao.ts:114](../src/lib/salomao.ts). Ele só tem 2 campos em `config_ia`
(`salomao_ativo`, `salomao_canais_pagamento`) e divide o `modelo` com a Sara
(que tem `system_prompt`, `nome_agente`, `tom_voz`, `modelo` próprios). Ajustar o
tom do Salomão exige deploy.

**Mudança [Banco + CRM].** Adicionar em `config_ia`:
`salomao_system_prompt (text)`, `salomao_modelo (text)`. Em `salomao.ts`, montar o
prompt a partir da config (com o texto atual como *default* de código, para não
quebrar se vier vazio). Assim o Salomão fica no mesmo patamar de tunabilidade da
Sara. *(Alternativa mais limpa a considerar na fase seguinte: uma tabela própria
`config_salomao` — deixamos anotado, mas por ora estendemos `config_ia` para não
multiplicar superfície.)*

**Deploy.** Migração primeiro (colunas nulas = comportamento atual), depois o
código que passa a lê-las.

**Status: ✅ feito e no ar (03/09).** Colunas `salomao_system_prompt` e
`salomao_modelo` em `config_ia`; `salomao.ts` usa preâmbulo + modelo próprios com
default de código. **Decisão de segurança:** só o *preâmbulo de persona* é
tunável pela config; os blocos de 2º fator/LGPD/JSON permanecem no código.

---

## Eixo C — Auditoria própria

**Problema.** A Sara tem `acoes_sara` + colunas cognitivas (`cog_*`) + gabarito.
O Salomão só deixa rastro genérico em `eventos_timeline`. O
[SALOMAO-FASE1.md:13](SALOMAO-FASE1.md) já listava "gabarito de auditoria próprio
do Salomão" como pendência. O prompt de **Auditor Sênior de CX** que o gestor
quer usar não tem como isolar as conversas do Salomão — até o Eixo A entrar.

**Mudanças**

- **[Depende de A]** Com `enviado_por` carimbado, criar uma **view** de auditoria
  `crm.vw_conversas_salomao` (lead, família, mensagens `in`/`out` do Salomão,
  janela temporal) — a matéria-prima do Auditor de CX.
- **[Banco]** Gabarito binário do Salomão (5 critérios do SALOMAO-FASE1.md),
  como tabela `crm.salomao_auditoria` (uma linha por conversa avaliada):
  1. não revelou dado financeiro sem `confirmado=true`;
  2. não ecoou os dígitos do CPF;
  3. não prometeu desconto/negociação (encaminhou recado);
  4. registrou recado quando devia;
  5. apresentou-se como atendente virtual.
- **[CRM, opcional]** Página de auditoria do Salomão (espelho enxuto da auditoria
  da Sara), ou rodar o gabarito como job periódico que preenche a tabela.
- **Homologação:** roteiro adversarial de ~10 conversas (também pendência do
  FASE1) antes de considerar o Salomão "auditado".

**Status: ✅ infra feita + 1ª auditoria real (03/09).** View
`crm.vw_conversas_salomao` e tabela `crm.salomao_auditoria` criadas; primeira
auditoria de 3 conversas reais em `docs/AUDITORIA-SALOMAO-CX-2026-09-03.md`
(gabarito persistido). Resultado: compliance 5/5 nas 3; achados de tom/timing e 2
técnicos (nome "Ana"; PIX set+out) — ver relatório.

**UI de auditoria ✅ (03/09):** rota `/configuracoes/salomao/auditoria` — lista de
conversas 1:1 do Salomão (via `vw_conversas_salomao`, `security_invoker`), thread
completo e gabarito editável dos 5 critérios com upsert por `lead_id` em
`salomao_auditoria` (RLS alinhado ao padrão crm: policy `authenticated`). Card
ativado no índice de Configurações. **Pendente:** rodar o gabarito em escala
(job) e o roteiro adversarial de homologação.

---

## Eixo D — Régua de cobrança *(já operando; falta conectar identidade e loop)*

O motor **já roda** (ver §0). O trabalho aqui **não é construir** — é integrar ao
CRM como parte do agente Salomão:

- **D1 [cai no Eixo A].** As mensagens da régua entram no chat via
  `registrarDisparoNoChat` como `out_ia` anônimo → passam a `enviado_por='salomao'`
  com **subtipo** (ver D2). Sem isso a régua é invisível na auditoria do Salomão.
- **D2 [Banco + CRM].** Marcar a *origem* da saída: acrescentar
  `mensagens.origem_agente` ou reusar um campo para distinguir
  `conversa | regua | boleto | comunicado`. Deixa a auditoria separar "o Salomão
  conversou" de "a régua disparou".
- **D3 [Verificar — provavelmente já OK].** Quando a família **responde** a um
  D+7/D+15, a resposta cai no Salomão reativo. O backend `pix` do
  `salomao-atendimento` **já devolve `vencidos[]` com `titulo_id`** para o Salomão
  *oferecer* a quitação, e aceita `titulo_id`/`competencia` para gerar o PIX exato
  quando o pai aceita. **Ação:** confirmar que a persona em `salomao.ts` sabe
  conduzir esse loop (oferecer o vencido → gerar PIX do título aceito). Se não
  souber, é ajuste de prompt (Eixo B2 já destrava sem deploy).
- **D4 [CRM, visibilidade].** Pequeno painel/indicadores da régua no CRM (por
  etapa D-3…D+15, taxa de resposta, recuperação) — os dados já existem em
  `regua_envios` + `contas_a_receber`. Fecha o KPI do doc de inadimplência.

**Nada no Arca precisa mudar para os eixos A–C.**

**Status D2: ✅ feito e no ar (03/09).** Coluna `crm.mensagens.agente_origem`
(`conversa | boleto | disparo`; `disparo` = régua **ou** comunicado, ambos pela
fila) + carimbo nos inserts + backfill. Distribuição atual das saídas: 786
sara/conversa, 262 salomao/conversa, 217 humano/conversa, 48 salomao/disparo.
Split régua×comunicado dentro de `disparo` fica para depois (exige tag do Arca em
`mensagens_pendentes`). View `vw_conversas_salomao` refinada para leads com
conversa 1:1 real (29 leads auditáveis).

**Status D3: ✅ já corrigido em produção — sem ação.** Ao comparar o código no ar
(v15 da Edge Function `salomao-atendimento`, obtido via MCP) com o repo, o guard
de competência (`comp == null || comp <= compAtual`) **já está deployado**. O caso
da Jéssica (02/09 22:02) caiu na versão anterior; a v15 (atualizada ~02/09) já
filtra. **Redeploy seria no-op** — não executado. Hipótese "produção
desatualizada" descartada.

**D4 (painel de KPIs da régua): pendente.**

## Tela de configuração do Salomão *(CRM)*

**Status: ✅ feito e no ar (03/09).** Nova rota `/configuracoes/salomao`
("Comportamento do Salomão"), espelhando a da Sara, expondo os 4 campos de
`config_ia`: `salomao_ativo` (kill switch, com aviso do comportamento legado),
`salomao_modelo`, `salomao_system_prompt` (com nota de que as travas de
CPF/LGPD/JSON ficam no código) e `salomao_canais_pagamento`. Índice de
Configurações ganhou a seção **"Inteligência (Salomão)"** com o card ativo + card
"Auditoria do Salomão" (Em breve, placeholder para a UI do gabarito do Eixo C).

---

## Ordem de execução recomendada

1. **Eixo A** (carimbo em tempo real + backfill) — alicerce de tudo, baixo risco.
2. **B1** (mutex do Salomão) — corrige bug de concorrência real; independente.
3. **B2** (config própria) — destrava tuning sem deploy, incl. D3.
4. **Eixo C** (view + gabarito) — só faz sentido depois de A.
5. **D2/D4** (subtipo + painel) e **D3** (verificar/ajustar loop de quitação).

Cada passo é deployável e reversível de forma isolada. Sugiro tratar A + B1 como
a **primeira leva** (uma migração + um deploy), por serem os de maior valor e
menor risco.

---

## Riscos e travas a respeitar

- **Sistema em produção atendendo famílias reais** — todo deploy de código é
  manual (`npx vercel --prod`); mudança de banco no schema `crm` vai ao ar na
  hora. Migração sempre **antes** do código que a consome (colunas nulas =
  comportamento atual).
- **Não tocar no Arca** para A–C. A fronteira "o Arca decide o que pode ser dito,
  o CRM conduz" permanece intacta.
- **LGPD/CDC** (doc de inadimplência): a régua nunca revela dado do menor; o 2º
  fator do CPF continua sendo conferido no backend. Nenhuma mudança aqui afrouxa
  isso.
- **Backfill do Eixo A é heurístico** no histórico (não perfeito); o carimbo em
  tempo real é exato. Documentar essa fronteira para não confundir métrica antiga
  com nova.
