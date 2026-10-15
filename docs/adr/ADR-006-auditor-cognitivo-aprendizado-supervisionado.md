# ADR-006: Auditor Cognitivo da Sara — Aprendizado Supervisionado com Aplicar/Rejeitar

**Status:** Proposed
**Autor:** Painel C-Level (Vision Chief, COO Orchestrator, CTO Architect, CAIO Architect, CMO Architect, CIO Engineer) + Aleshan
**Data:** 2026-07-17
**Relacionado:** ADR-004 (Follow-up automático da Sara), ADR-005 (Captura de mensagens manuais), `docs/C-LEVEL-MA-OS-COMO-AUDITOR-SARA.md`

---

## Contexto

O manifesto "MA OS" propõe uma arquitetura cognitiva completa (Decision Engine, Learning Engine, sistema autoevolutivo). A mesa redonda anterior concluiu: **não construir o OS; construir o primeiro órgão dele — o Auditor da Sara — como campo de provas da tese cognitiva, no lugar de menor risco.**

Esta ADR concretiza a decisão do founder: rodar a tese cognitiva **por dentro do CRM**. O Auditor lê conversas encerradas, sugere correções/melhorias na tela `/auditoria`, e cada sugestão tem dois botões: **Aplicar** ou **Rejeitar**.

Fato técnico que viabiliza tudo (verificado em `src/lib/sara.ts`): **a Sara já monta o comportamento em tempo de execução a partir do banco** — `config_ia.system_prompt` + `base_conhecimento` + `anotacoes` por lead, carregados a cada atendimento. Mudar o comportamento dela é escrever numa tabela; não exige deploy nem editar código. O botão "Aplicar" tem, portanto, uma casa limpa e imediata.

**O risco central que esta ADR precisa neutralizar:** um "Aplicar" que transforme o aprendizado de **uma** conversa numa regra **global** com um clique. Isso é o "aprender o ruído" — uma conversa que converteu por sorte viraria lei, a Sara sofreria drift, e o auditor se tornaria a coisa menos auditável do sistema.

## Decisão

Implementar um **loop de aprendizado supervisionado de dois níveis**, com regras versionadas e reversíveis.

### 1. O Auditor gera sugestões estruturadas

Após uma conversa encerrada (cron diário já existente), um segundo LLM — **distinto da Sara**, prompt próprio, temperatura baixa, saída JSON — avalia a conversa contra o gabarito de 10 critérios (ancorados em desfecho, ver ADR de gabarito) e emite `sugestoes_auditoria`: diagnóstico + correção proposta, por critério.

> Regra: a Sara **nunca** se audita no mesmo passo. Auto-avaliação de LLM é enviesada para se dar razão.

### 2. Nível 1 — Correção da conversa (barato, seguro, clique livre)

Cada sugestão aparece na tela `/auditoria` com **Aplicar / Rejeitar**. Neste nível, "Aplicar" apenas:
- **valida o diagnóstico** daquela conversa (calibra o auditor / vira dado de treino do gabarito), e/ou
- grava uma `anotacao` pontual no lead (se ainda ativo).

**Não toca a Sara global.** Sem risco. É rotulagem humana.

### 3. Nível 2 — Promoção de regra (global, com trava de evidência)

Uma sugestão só vira **candidata a regra global** depois de **reaparecer N vezes** em conversas distintas (agrupadas por `hash_padrao`). Só então surge o botão **"Aplicar como regra"**, numa fila separada ("Regras candidatas"), exibindo a evidência (nº de ocorrências + correlação com o KPI).

- **Aplicar como regra** → insere linha versionada em `regras_aprendidas` (`ativa = true`). A Sara passa a ler essa regra no **próximo** atendimento. Efeito imediato, sem deploy.
- **Rejeitar** → `status = 'rejeitada'`, com motivo.
- **Rollback** → desativar a versão (`ativa = false`). Reversível a qualquer momento.

### 4. Ponto de plugue na Sara (`sara.ts`)

No builder do `systemPrompt`, após carregar `config_ia`/`base_conhecimento`, carregar também:

```ts
const { data: regras } = await supabase
  .from('regras_aprendidas')
  .select('texto_regra')
  .eq('escola_id', escolaId)
  .eq('ativa', true)
  .order('criada_em', { ascending: true })
```

e concatenar como um bloco `REGRAS APRENDIDAS (validadas pela supervisão)` com prioridade análoga às `anotacoes`. Uma única adição; nenhuma reescrita.

### 5. Modelo de dados (Supabase)

```sql
-- Sugestões cruas do auditor (Nível 1)
create table sugestoes_auditoria (
  id            uuid primary key default gen_random_uuid(),
  escola_id     uuid not null,
  lead_id       uuid references leads(id),
  conversa_ref  text,                 -- referência à conversa auditada
  criterio      text not null,        -- qual dos 10 critérios
  diagnostico   text not null,        -- o que a Sara errou
  sugestao      text not null,        -- correção proposta
  tipo          text not null,        -- 'correcao_sara' | 'ajuste_gabarito'
  hash_padrao   text not null,        -- agrupa sugestões equivalentes
  status        text not null default 'pendente', -- pendente|validada|rejeitada
  revisado_por  text,
  revisado_em   timestamptz,
  created_at    timestamptz default now()
);

-- Regras globais versionadas (Nível 2) — o Decision Engine de verdade
create table regras_aprendidas (
  id              uuid primary key default gen_random_uuid(),
  escola_id       uuid not null,          -- fronteira multi-tenant desde o dia 1
  texto_regra     text not null,          -- padrão abstraído, SEM PII de conversa
  origem_hash     text not null,          -- de qual padrão nasceu
  n_observacoes   int not null,           -- quantas conversas sustentaram
  versao          int not null default 1,
  ativa           boolean not null default true,
  status          text not null default 'ativa', -- candidata|ativa|aposentada|rejeitada
  kpi_baseline    numeric,                -- KPI-estrela no momento da ativação
  kpi_pos         numeric,                -- KPI medido após X semanas
  criada_por      text not null,
  criada_em       timestamptz default now(),
  aposentada_em   timestamptz,
  motivo          text
);

-- Trilha de auditoria das ações humanas (governança / LGPD)
create table regras_eventos (
  id          uuid primary key default gen_random_uuid(),
  regra_id    uuid references regras_aprendidas(id),
  acao        text not null,   -- aplicar|rejeitar|aposentar|reativar
  por         text not null,
  em          timestamptz default now(),
  observacao  text
);
```

### 6. Guardrails não-negociáveis

- **Medir (COO):** toda regra ativada guarda `kpi_baseline`; um job semanal preenche `kpi_pos`. Regra que não move o KPI-estrela (conversa→visita) em 4 semanas é sinalizada para revisão.
- **Esquecer (CAIO):** regra sinalizada e não defendida é **aposentada** (`ativa=false`). Sem isso, o `system_prompt` da Sara incha para centenas de regras contraditórias e ela piora por diluição de contexto. O motor esquece tanto quanto aprende.
- **Kill switch (CAIO):** um toggle em `configuracoes` desliga **todas** as regras aprendidas de uma vez → a Sara volta ao `base + KB`. Recuperação em um clique.
- **LGPD / dado de menor (CIO):** `regras_aprendidas.texto_regra` guarda **padrão abstraído** ("dar preço antes de descobrir a necessidade reduz conversão"), **nunca** transcrição de conversa com nome/idade da criança. `escola_id` obrigatório em toda linha — o aprendizado de uma escola não vaza para outra.
- **Governança leve (CIO):** a revisão da fila de regras candidatas é semanal, em lote (30 min). É o único órgão de governança — nada de comitês.

---

## A mesa redonda (exposta)

**👔 Vision Chief —** Aprovo, com uma condição de identidade: isto **é** o Decision Engine nascendo, não uma feature de auditoria. A diferença não é semântica. Significa que a régua de sucesso não é "a tela ficou bonita", é "as regras aplicadas moveram matrícula". Se em 90 dias você tiver 5 regras ativas e nenhuma mover o KPI, o experimento **falhou de propósito** e nos ensinou que o gabarito está errado — o que é um sucesso barato. O que eu não aceito é rodar isso sem olhar o número.

**⚙️ COO Orchestrator —** O design está certo *se* a fila de Nível 2 mostrar a evidência na cara. Cada regra candidata tem que aparecer com "23 conversas, dessas 23 apenas 4 agendaram visita vs. 61% da base". O botão "Aplicar" sem esse número ao lado é um convite a decidir por intuição — exatamente o que o auditor deveria eliminar. Métrica ao lado do botão, ou o botão mente.

**🔧 CTO Architect —** Tecnicamente é boring, e boring é elogio. Três tabelas, uma leitura a mais em `sara.ts`, botões numa tela que já existe. Zero microsserviço, zero "arquitetura cognitiva". Um único cuidado de engenharia: a saída do auditor **tem que ser JSON validado por schema** (nota + justificativa por critério). Texto livre do LLM na fila de sugestões vira lixo não-agrupável e o `hash_padrao` não funciona. Estrutura na entrada é o que torna o aprendizado possível.

**🤖 CAIO Architect —** É a versão responsável do "autoevolutivo" do manifesto — e é por isso que eu assino embaixo. O sistema **aprende** (captura todo padrão), mas **não se auto-modifica** (todo passo global passa por humano + evidência + versão). Você está em "assistido" e permanece lá de propósito. Minhas duas linhas vermelhas já estão na decisão: threshold de N observações antes de qualquer promoção, e o esquecimento ativo. Sem o esquecimento, isto vira um acumulador de regras que degrada a Sara em 6 meses — esse é o modo de falha mais comum e mais ignorado.

**📣 CMO Architect —** Do meu ângulo, esta tela é o seu **ativo de vendas** disfarçado de feature interna. No dia em que uma escola vê "o sistema detectou 3 padrões de perda e, após validação, a taxa de visita subiu de 38% para 51%", você não está mais vendendo um chatbot — está vendendo a narrativa "MA OS" com prova. Mas só depois do número. Continua valendo: entregue o resultado, depois conte a história.

**🖥️ CIO Engineer —** Assino com as travas de dado explícitas na tabela: `texto_regra` abstraído (sem PII de menor), `escola_id` em tudo, e `regras_eventos` como trilha de quem aprovou o quê. Isso não é burocracia — é o que te deixa dormir quando houver a segunda escola e quando a LGPD perguntar "com base em qual dado de qual criança essa regra foi criada?". A resposta tem que ser "nenhum — a regra é um padrão abstraído", e a tabela precisa provar isso.

---

## Alternativas consideradas

- **"Aplicar" único que edita direto o `config_ia.system_prompt`:** rejeitado. Um clique de uma conversa alterando o prompt global é o gerador de drift que o CAIO travou. Mantido apenas como o que acontece *depois* da promoção de Nível 2, versionado.
- **Auditor autônomo (aplica regras sozinho acima de um score):** rejeitado para a v1. Pula de "assistido" para "autônomo" sem provar valor no meio. Reavaliar só depois de o loop supervisionado provar lift.
- **A Sara se auto-audita no mesmo passo do atendimento:** rejeitado. Viés de auto-avaliação + acopla auditoria à latência do atendimento. Auditor é segundo julgamento, offline.
- **Guardar a transcrição da conversa na regra (para "contexto"):** rejeitado por LGPD. Aprende-se o padrão abstraído, não o texto com dados da criança.
- **Sem esquecimento (só acumular regras):** rejeitado. Incha o prompt, cria contradições, degrada a Sara. O esquecimento é parte da decisão, não um "depois".

## Consequências

**Positivas:**
- A tese cognitiva inteira roda dentro do CRM, no lugar de risco zero (conversas encerradas).
- A Sara vira `base + regras validadas` — versionada, reversível, auditável. O Decision Engine existe de verdade, sem OS.
- Todo aprendizado é capturado; nada muda o comportamento global sem humano + evidência + medição.
- Base pronta para multi-tenant e para a narrativa de vendas (CMO), com LGPD desde o design.

**Negativas / custos:**
- Custo de LLM extra por conversa auditada (mitigável: só conversas encerradas, batch no cron).
- Exige disciplina de revisão semanal da fila de candidatas (30 min) — se o humano não revisar, a fila estagna e o aprendizado congela.
- O gabarito precisa estar ancorado em desfecho **antes** disso valer algo (pré-requisito, ADR do gabarito).
- Threshold N mal calibrado: muito alto trava o aprendizado, muito baixo aprende ruído. Começar em N≈20 e ajustar pelo dado.

**Trade-off aceito:** mais um passo humano no loop (revisão semanal + dois níveis de Aplicar) em troca de um sistema que aprende sem derivar, é auditável, e prova valor num número antes de virar produto. Correto para uma IA que atende famílias e alimenta a decisão comercial da escola.

## Próximos passos

1. **[Pré-requisito / COO+CAIO]** Reescrever os 10 critérios do gabarito ancorados no KPI conversa→visita (ADR do gabarito). Sem isso, o auditor sugere sobre "vibe".
2. **[CTO]** Migração Supabase: `sugestoes_auditoria`, `regras_aprendidas`, `regras_eventos`.
3. **[CTO]** Adicionar a leitura de `regras_aprendidas` ativas no builder de `sara.ts`.
4. **[CTO]** Auditor LLM com saída JSON validada por schema; popular `sugestoes_auditoria` no cron.
5. **[CTO/UX]** Tela `/auditoria`: Nível 1 (Aplicar/Rejeitar por conversa) + fila de "Regras candidatas" com evidência (Nível 2) + kill switch em `configuracoes`.
6. **[COO]** Job semanal de medição (`kpi_baseline` → `kpi_pos`) e sinalização de regras sem lift.
7. **[Vision]** Revisão em 90 dias: quantas regras ativas, quantas moveram o KPI. Gate para generalizar (ou não) rumo ao "MA OS".
