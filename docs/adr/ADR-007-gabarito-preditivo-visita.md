# ADR-007: Gabarito Preditivo da Sara — 10 Critérios Ancorados na Visita

**Status:** Proposed — **Revisado em 2026-07-17 (Revisão 1, pós-Auditoria Fase A)**
**Autor:** Painel C-Level (COO Orchestrator, CAIO Architect, CTO Architect, Vision Chief) + Aleshan
**Data:** 2026-07-17
**Relacionado:** ADR-006 (Auditor Cognitivo) — este é o **pré-requisito** dela. `docs/AUDITORIA-FASE-A-2026-07-17.md`.

---

## ⚠️ Revisão 1 — o alvo mudou de "agendou" para "COMPARECEU"

A primeira rodada real do auditor (14 conversas, Fase A) provou que o alvo original estava errado:

- **Das 6 famílias que agendaram visita, só ~2 compareceram; 3 deram No Show.** Agendar é fácil — a Sara agenda bem. O dinheiro está em **fazer comparecer**. Otimizar "agendou" otimiza um número que não paga a conta.
- Portanto o **KPI-estrela passa a ser a taxa `conversa → visita REALIZADA` (compareceu)**, não `conversa → visita agendada`. Onde este documento disser "visita/agendar" como alvo, leia **"comparecimento"**.
- O funil vira **dois passos**: `conversa → agendou → compareceu`. Agendar continua sendo pré-condição necessária, mas o **vazamento crítico é agendou→compareceu** (No Show). Os critérios que constroem valor e confiança (Diagnóstico, Construção de Valor, Confiança) — e não o Convite — é que sustentam o comparecimento.

**Mudanças no gabarito que a Fase A já exige:**

1. **Novo critério — "Objeção de preço bem tratada"** (peso alto proposto: 2,0). A Fase A mostrou que o *stonewall* de preço ("não temos tabela única") é o maior preditor de perda/No Show; quem recebeu um "a partir de R$X" real engajou. Este critério NÃO existia no gabarito original e é provavelmente o mais discriminante. Pleno = ancorou com faixa real e conectou a valor; Ausente = recusou repetidamente.
2. **Rebaixar "Convite"** de 2,0 → **1,0**. Ele não discrimina: a Sara convida em quase toda conversa, ganhando ou perdendo. Peso alto nele é ruído.
3. **Peso de "Confiança" sobe** de 1,0 → **1,5** — é o que separa quem agenda de quem realmente aparece.

**Label de "compareceu" (rótulo de validação) — IMPLEMENTADO em 2026-07-17:**

- Evento `eventos_timeline.tipo = 'visita_realizada'` agora é emitido pelo trigger `fn_timeline_lead_movido` sempre que um lead entra na coluna "Visita Realizada" (qualquer caminho: Kanban, modal, API, Sara), idempotente (1 por lead). Espelho do `visita_agendada`. Constraint `eventos_timeline_tipo_check` atualizada; histórico backfillado. Estado inicial: **compareceu=3, agendou=6**.
- Correção de um engano anterior: o `movido_coluna` grava descrição genérica, mas o **`metadados` guarda `coluna_anterior`/`coluna_nova`** — o histórico do funil **é** reconstruível. Ainda assim o evento explícito é mais limpo e semântico.
- Rótulo final = tem evento `visita_realizada` **OU** está/esteve no funil `Matriculados` (matrícula implica visita).

Query de rotulagem revisada (alvo = compareceu):

```sql
select l.id as lead_id, fam.nome_responsavel,
  case when exists (select 1 from eventos_timeline e where e.lead_id=l.id and e.tipo='visita_agendada') then 1 else 0 end as agendou,
  case when c.nome ilike '%Visita Realizada%' or f.nome ilike '%Matricul%'
       or exists (select 1 from eventos_timeline e where e.lead_id=l.id and e.tipo='visita_realizada')
       then 1 else 0 end as compareceu   -- RÓTULO-ALVO
from leads l
join colunas c on c.id=l.coluna_id
join funis f on f.id=c.funil_id
join familias fam on fam.id=l.familia_id
where exists (select 1 from mensagens m where m.lead_id=l.id and m.direcao='in')
order by compareceu desc, agendou desc;
```

O restante do documento (rubrica 0/1/2, evidência citada, saída JSON, validação por correlação, gate N≥~50) **permanece válido** — muda o alvo que tudo isso prevê e os três pesos acima. A `probabilidade_holistica` passa a estimar **chance de comparecimento**, não de agendamento.

---

## Contexto (original — alvo substituído pela Revisão 1 acima)

O Auditor da ADR-006 só vale alguma coisa se o gabarito medir a coisa certa. Um critério como "a Sara foi cordial" é opinião; não ensina nada e não prevê nada. A decisão da mesa foi clara: **os 10 critérios deixam de ser avaliação subjetiva e passam a ser preditores de um único desfecho — a visita agendada** (KPI-estrela: taxa conversa→visita).

Aleshan trouxe a base desta ADR: 10 critérios como perguntas objetivas. Aceita e elevada, com **uma correção estrutural**:

> **"Probabilidade de visita" NÃO é um dos critérios.** É o *output* que os outros critérios preveem. Tê-la como critério de entrada é circular — a chance de agendar estimando a chance de agendar, com peso igual às causas. Ela vira a **saída** do auditor, validada contra o desfecho real (a família agendou, sim/não).

## Decisão

### 1. Nove critérios preditores + uma saída calibrada

Os critérios são **causas** observáveis na conversa. A probabilidade de visita é o **efeito** estimado. Separá-los é o que permite validar o gabarito contra a realidade.

### 2. Cada critério tem 4 componentes (não é nota solta)

- **Definição operacional** — o que exatamente conta como "atingido".
- **Sinais de evidência** — trechos concretos que o auditor procura (e deve **citar**).
- **Rubrica ancorada 0 / 1 / 2** — Ausente / Parcial / Pleno, com âncora textual. (LLM pontua muito mais consistente em 3 níveis ancorados do que numa escala 0-100 "de sensação".)
- **Peso-hipótese** — quanto se acredita que o critério prevê a visita. É **hipótese inicial**, recalibrada pelo dado (ver §4).

### 3. Os 9 critérios preditores

| # | Critério | Definição operacional (Pleno = 2) | Sinais de evidência | Peso-hipótese |
|---|----------|-----------------------------------|---------------------|:---:|
| 1 | **Conexão inicial** | Houve acolhimento/rapport **antes** de orientar ou vender. | Saudação personalizada; espelhar o tom da família; usar o nome; não despejar preço/regras de cara. | 0,5 |
| 2 | **Qualificação** | Nome da criança **e** idade/série **e** turno pretendido foram identificados. | "Qual a idade do(a)…?", "Para qual série?"; a família responde com os 3 dados. | 1,0 |
| 3 | **Diagnóstico** | O **motivo real** da busca (a dor/o gatilho de agora) foi compreendido, não só os dados. | "O que te fez procurar a escola agora?"; menção a mudança, insatisfação com a atual, valores, rotina. | 1,5 |
| 4 | **Construção de valor** | Diferenciais foram conectados **à necessidade específica** daquela família (não genéricos). | Ligação explícita entre a dor do #3 e um diferencial ("como vocês valorizam X, aqui…"). | 1,5 |
| 5 | **Convite** | A visita foi apresentada como o **próximo passo natural**, com proposta concreta (dia/horário). | "Que tal conhecer a escola na terça às 10h?"; oferta de 2 opções de horário. | 2,0 |
| 6 | **Clareza** | Ao fim, a família sabe **exatamente** o que fazer a seguir; zero ambiguidade. | Instrução única e explícita; ausência de "qualquer coisa me chama". | 1,0 |
| 7 | **Continuidade** | Existe um **próximo passo registrado** (visita marcada, retorno agendado, follow-up com data). | Slot reservado; data de retorno combinada; compromisso mútuo verbalizado. | 1,5 |
| 8 | **Fluência (ex-"Tempo")** | A conversa fluiu sem fricção que esfria: sem deixar a família esperando longos gaps, sem repetir perguntas já respondidas. | Respostas em ritmo; não pergunta o que a família já disse; sem silêncios longos no meio do interesse. | 0,5 |
| 9 | **Confiança** | Há evidência de **aumento** de confiança ao longo da conversa. | Família passa a compartilhar mais espontaneamente; faz perguntas "para frente" ("tem vaga?", "como é a matrícula?"); sentimento positivo. | 1,0 |

> **Nota sobre #8:** é o critério mais fraco como preditor e o mais difícil de medir por texto. Fica marcado como **candidato a poda**: se a validação histórica (§4) mostrar correlação ~zero com a visita, ele sai. Não se apega a um critério que não prevê.

### 4. A saída do auditor (o que era o "critério 10")

Duas saídas, não uma:

- **Score preditivo (calculado):** soma ponderada dos 9 critérios ÷ máximo possível → 0-100. Mapeado em faixas: **Frio** (0-39) / **Morno** (40-69) / **Quente** (70-100).
- **Probabilidade holística (estimada pelo LLM):** o auditor também dá um palpite direto de 0-100% ("com base na conversa inteira, chance de agendar"). Serve de **calibração**: se o score calculado e o palpite holístico divergem muito, o gabarito está incompleto — sinal de que falta um critério ou os pesos estão errados.

E a única verdade que importa: **o desfecho real.** Cada conversa auditada é cruzada com "essa família agendou visita? (sim/não)". É isso que valida se o gabarito prevê a realidade.

### 5. Validação como preditor (fecha o loop com a ADR-006)

O gabarito não é aceito por ser bonito; é aceito por prever. Método:

1. Rodar o auditor sobre o **histórico** de conversas já rotuladas por desfecho (agendou / não agendou).
2. Para cada critério, medir a **correlação com o agendamento** (ex.: conversas com #5 "Pleno" agendam em X% vs. Y% quando "Ausente").
3. **Recalibrar os pesos** para os valores empíricos; **podar** critérios com correlação ~zero (candidato: #8).
4. Medir o poder preditivo do score como um todo (ex.: AUC / taxa de acerto das faixas Frio/Morno/Quente).
5. Repetir trimestralmente — o gabarito é vivo. Isto **é** o Learning Engine operando sobre o próprio gabarito.

### 6. Schema de saída (JSON — exigência do CTO na ADR-006)

```json
{
  "conversa_ref": "…",
  "criterios": [
    { "id": 1, "nome": "conexao_inicial", "nivel": 0, "evidencia": "cite o trecho", "justificativa": "…" }
    // … 9 critérios
  ],
  "score_preditivo": 0,
  "faixa": "frio | morno | quente",
  "probabilidade_holistica": 0,
  "gap_dominante": "qual critério, se corrigido, mais aumentaria a chance de visita",
  "sugestao": "correção acionável para a Sara (vira sugestao_auditoria da ADR-006)"
}
```

O `gap_dominante` é a ponte para o aprendizado: é ele que, recorrente em N conversas, vira regra candidata (Nível 2 da ADR-006).

---

## A mesa redonda (exposta)

**⚙️ COO Orchestrator —** A correção do #10 é o que separa isto de um teatro de métricas. Um gabarito que se auto-prevê não mede nada. Agora cada critério é uma alavanca que eu posso puxar e medir. E os pesos são hipótese até o dado falar — ótimo, porque significa que a primeira rodada sobre o histórico pode me dizer "seu instinto sobre o Convite estava certo, mas Conexão inicial não prevê nada". Isso é gestão, não achismo.

**🤖 CAIO Architect —** Rubrica de 3 níveis ancorados em vez de escala 0-100 é a decisão técnica mais importante aqui — reduz a variância do LLM em ordem de grandeza. E exigir a **citação da evidência** por critério é o que torna o Aplicar/Rejeitar da ADR-006 confiável: o humano vê o trecho e julga em 5 segundos. Sem evidência citada, o auditor vira uma caixa-preta que você aprende a ignorar.

**🔧 CTO Architect —** O schema JSON com `nivel` inteiro e `evidencia` como string fecha com o `hash_padrao` da ADR-006: sugestões viram agrupáveis porque a saída é estruturada. Um detalhe de implementação: o `score_preditivo` é **calculado em código** a partir dos níveis, não pedido ao LLM. LLM não faz aritmética confiável — ele dá os níveis e a evidência; o peso e a soma são nossos. Isso também deixa a recalibração de pesos ser um `UPDATE`, não um re-prompt.

**👔 Vision Chief —** Aprovado. Reparem no que aconteceu: a sugestão do Aleshan já estava 80% certa, e a mesa consertou os 20% que teriam feito o sistema mentir pra ele por meses (o critério circular). Esse é o valor do processo. Uma exigência de dono: a primeira coisa a rodar é a validação histórica do §5. Se não tivermos desfecho rotulado suficiente no banco, **esse** vira o gargalo — e é melhor descobrir isso agora do que depois de construir a tela.

---

## Alternativas consideradas

- **Manter "probabilidade de visita" como 10º critério:** rejeitado — circular; polui o score com o próprio efeito.
- **Escala 0-10 por critério:** rejeitado — variância alta do LLM, pontuação inconsistente entre conversas. 0/1/2 ancorado vence.
- **Pesos iguais para os 10:** rejeitado — dilui os preditores fortes (Convite, Continuidade) nos fracos (Fluência). Pesos-hipótese recalibrados pelo dado.
- **Pedir o score final ao LLM:** rejeitado — aritmética por LLM é não-confiável. Níveis + evidência do LLM; soma ponderada em código.
- **Gabarito fixo:** rejeitado — vira legado em 3 meses. Revisão trimestral pelos dados de desfecho.

## Consequências

**Positivas:**
- Cada critério é auditável (evidência citada), ensinável (gap dominante) e **validável** (correlação com a visita).
- O score prevê um número de negócio real; o auditor vira ferramenta de melhoria contínua, não avaliador.
- Saída estruturada destrava o agrupamento e o aprendizado da ADR-006.
- Pesos vivos: o gabarito melhora com os dados de desfecho.

**Negativas / custos:**
- **Depende de desfecho rotulado** (agendou/não) no histórico. Se o banco não registra isso de forma confiável, é o primeiro gargalo a resolver.
- Recalibração trimestral exige disciplina de análise (leve, mas real).
- Critério #8 provavelmente será podado — aceitar a poda sem apego.

**Trade-off aceito:** mais rigor na definição (rubricas, evidência, validação) em troca de um gabarito que prevê a realidade em vez de opinar sobre ela. É o alicerce sem o qual a ADR-006 apenas automatiza achismo.

## Próximos passos (atualizados pela Revisão 1)

1. ~~**[CTO]** Emitir evento `visita_realizada`~~ ✅ **FEITO (2026-07-17)** — trigger `fn_timeline_lead_movido` estendido + constraint atualizada + backfill. Rótulo limpo de comparecimento ativo.
2. **[Gabarito]** Aplicar as mudanças da Revisão 1: adicionar critério "Objeção de preço" (peso 2,0), rebaixar "Convite" (2,0→1,0), subir "Confiança" (1,0→1,5). Recalcular `max_pontos`.
3. **[CAIO]** Atualizar o prompt do auditor (`docs/prompt-auditor-sara.md`) com o critério de preço e a `probabilidade_holistica` prevendo **comparecimento**.
4. **[Dados]** Acumular desfecho "compareceu" até N≥~50 antes de recalibrar pesos ou podar critério (#8 Fluência segue candidato a poda).
5. **[CTO]** Cálculo do `score_preditivo` em código (pesos em tabela, não no prompt).
6. Integrar com a ADR-006: `gap_dominante` → `sugestoes_auditoria` → fila de regras candidatas.

> **Bloqueador de qualidade (fora do gabarito):** a duplicação de mensagens da Sara segue **ativa** (sem dedup de entrada no webhook, sem índice único em `mensagens.whatsapp_message_id`; duplicata mais recente 2026-07-17). Auditar/treinar uma Sara que repete mensagem contamina o sinal — corrigir antes de escalar o auditor. (A alucinação de fatos fixos já está coberta pelo bloco anti-alucinação em `sara.ts`.)
