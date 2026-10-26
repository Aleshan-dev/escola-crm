# PRD — Escola CRM (Sara)

**Produto:** CRM de matrículas WhatsApp-first do Colégio Pequenos Guardiões
**Versão do documento:** 2.0 · **Data:** 2026-08-26 · *(v2.0 consolida tudo que entrou desde o as-built 1.0 de 12/08 — Salomão/boletos, guardião do Evolution, auditor cognitivo, integração SGEI e o fluxo anti-no-show — corrige o agendamento de crons para a Vercel (ADR-008) e reflete a faxina do repositório e o modelo de deploy pasta → Vercel)*
**Tipo:** As-built (fonte de verdade do que existe hoje) + Roadmap priorizado
**Fontes:** código em `D:\Claude\Projects\CRM Escola`, ADRs (`docs/adr/`), avaliação C-Level de 2026-07-02, jornada da Sara, política anti-bloqueio, docs Salomão/Arca.

> **Como ler este documento.** As Partes I–VII descrevem o sistema **como ele funciona hoje** — é o contrato de referência. A Parte VIII é o **roadmap** (o que falta e em que ordem). A Parte IX fixa **métricas**. Onde uma afirmação depende de configuração que pode mudar, o texto aponta o arquivo/tabela de origem em vez de gravar o valor como imutável.

---

## Sumário

- Parte I — Visão, problema e objetivos
- Parte II — Personas e jobs-to-be-done
- Parte III — Escopo funcional (o produto hoje)
- Parte IV — A Sara e o Salomão (agentes de IA)
- Parte V — Modelo de dados
- Parte VI — Integrações e automações (crons)
- Parte VII — Arquitetura, segurança e operação
- Parte VIII — Roadmap priorizado
- Parte IX — Métricas e critérios de sucesso
- Parte X — Riscos e decisões em aberto
- Anexo — Glossário

---

## Parte I — Visão, problema e objetivos

### 1.1 Visão

Ser a **máquina de conversão e nutrição** de matrículas do colégio: capturar cada família que chega pelo WhatsApp, qualificar, agendar a visita, garantir o comparecimento e reengajar quem esfria — sem que nenhum lead seja esquecido e sem depender de disparo em massa.

### 1.2 Problema que resolve

Venda de matrícula em educação infantil é consultiva, emocional e de alta confiança. As três maiores fontes de perda são: (1) **lead esquecido** — ninguém dá follow-up; (2) **no-show na visita** — a família agenda e não comparece; (3) **atendimento lento** — a resposta demora e a família fecha com outra escola. Antes do CRM o atendimento era manual, dependente da memória da equipe, e uma tentativa de disparo em massa já resultou em **bloqueio preventivo do número** no WhatsApp.

### 1.3 Objetivos do produto

1. **Speed-to-lead:** responder no WhatsApp de imediato, 24/7, com voz de marca consistente.
2. **Zero lead esquecido:** motor de follow-up determinístico que reengaja por etapa, com backoff e teto de tentativas.
3. **Reduzir no-show:** fluxo de confirmação de véspera + lembrete do dia + resgate acolhedor pós-falta.
4. **Não ser bloqueado:** só responder quem procurou a escola, com pacing e horário comercial.
5. **Trilha auditável:** toda mensagem, ação da IA e disparo registrados para revisão humana.

### 1.4 Princípio arquitetural central (não negociável)

> **A IA decide O QUÊ dizer; o sistema decide QUANDO/SE agir.**

A Sara gera texto (saída JSON estruturada). O funil, o backoff, o horário comercial, a elegibilidade do follow-up e o pacing são **código determinístico e auditável**. Essa separação é o maior acerto do projeto e deve ser preservada em qualquer evolução (ver ADR-004).

---

## Parte II — Personas e jobs-to-be-done

**Família (lead).** Responsável buscando escola para uma criança (berçário aos 5 anos). Interage exclusivamente pelo WhatsApp. Quer resposta rápida, informação clara sobre turma/horário/valores e conhecer a escola de perto. *JTBD: "encontrar uma escola segura e acolhedora para meu filho sem virar um projeto de pesquisa."*

**Consultora/atendente humana (equipe comercial).** Opera o Kanban, assume conversas quando a Sara transborda, escreve anotações internas (que voltam como contexto para a Sara), prioriza quem está quente. *JTBD: "não perder nenhum lead e saber onde focar meu tempo."*

**Gestor/dono.** Acompanha o funil, as metas de crescimento, o investimento por canal e a efetividade da automação. *JTBD: "provar que a máquina de matrícula funciona e saber onde investir verba."*

**Financeiro (via Salomão/Arca).** Dispara boletos pelo mesmo WhatsApp da escola. *JTBD: "cobrar sem esforço manual e sem estourar o número."*

---

## Parte III — Escopo funcional (o produto hoje)

### 3.1 Funil / Kanban

O coração operacional é um **Kanban com arrastar-e-soltar** (`src/app/kanban`, dnd-kit). Colunas e funis vêm do banco (tabelas `funis`, `colunas`) — há um funil padrão de captação (`is_padrao`). As etapas reais mapeadas no motor de follow-up (`followup-regras.ts → triggerPorColuna`) são:

| Etapa (coluna) | Significado | Gatilho de follow-up |
|---|---|---|
| **Capturados** | Família iniciou contato, sem atendimento completo | `primeiro_contato` |
| **Visita Agendada** | Visita marcada | `confirmacao_visita` (anti-no-show) |
| **Visita Realizada** | Família visitou | `followup_pos_visita` (lead quente) |
| **Repescagem** | Sem avanço / no-show a reagendar | `recuperacao` |
| **Matriculados** | Fechou matrícula | — |
| **Perdidos / Arquivados** | Descartado (`arquivado=true`, `motivo_perda`) | — |

Cada coluna tem `ia_ativa_default`, cor, ordem e parâmetros de follow-up (`followup_intervalo_horas`, `followup_max`). O card do lead abre o **LeadDetailModal** (histórico de mensagens, dados da família/criança, anotações internas, temperatura, próxima ação).

### 3.2 Score e temperatura

Cada lead tem `score` (0–100) e `temperatura` (`frio`/`morno`/`quente`), recalculados por **trigger no banco** (`fn_leads_score`) em qualquer caminho de escrita (webhook, movimentação no Kanban, follow-up) — não depende do app. Há `temperatura_manual` para override humano. Além do score, há uma camada **cognitiva** por lead (`cog_intencao`, `cog_emocao`, `cog_interesse`, `cog_urgencia`, `cog_probabilidade`, `cog_proxima_acao`) que a Sara preenche na análise de cada mensagem.

### 3.3 Atendimento e chat

- **Chat ao vivo** (`src/app/chat`, `ChatPopup`) com Supabase Realtime — a equipe vê e responde conversas em tempo real. *(Nota operacional já registrada em memória: Realtime exige a tabela `crm.mensagens` publicada em `supabase_realtime` e o cliente escutando o schema correto.)*
- **Handoff humano:** quando um humano responde pelo WhatsApp (`fromMe` → mensagem `out_humano`), a Sara **pausa automaticamente** naquele lead (`ia_ativa=false`). Mensagens têm três direções: `in`, `out_humano`, `out_ia`.
- **Transbordo:** a Sara pode sinalizar `transbordo=true` com motivo, empurrando o lead para atendimento humano.
- **Mídia:** áudio/imagem/documento tratados por `midia.ts` / `MidiaMensagem`.

### 3.4 Agendamento de visitas

- Disponibilidade calculada de `horarios_visita` × `tarefas` (`disponibilidade.ts`) — a Sara oferece **2 horários reais**, não genéricos.
- Ocupação cruzada com o **SGEI** (`getOcupacaoDireta`) para não oferecer vaga onde não há.
- Sincronização bidirecional com **Google Calendar** (push + webhook + renovação de watch).
- Telas: `/agendamentos`, config de `/configuracoes/horarios-visita`.

### 3.5 Configuração (config-driven)

Tudo que a Sara usa é configurável por tela, não hardcoded: **séries** (`/configuracoes/series`), **turnos** (`/configuracoes/turnos` — Parcial/Estendido/Integral), **horários de visita**, **origens** de lead, **motivos** de perda, **metas** de crescimento, **investimento** por canal, **notificações**, **persona da Sara** (`/configuracoes/sara`), e as **integrações** (WhatsApp Evolution, WhatsApp Cloud oficial, Google).

### 3.6 Telas principais

`/inicio` (dashboard: leads por série/origem/dono, metas, `v_followup_stats`, investimento por canal), `/kanban`, `/chat`, `/comunicacao`, `/responsaveis` (+ detalhe), `/agendamentos`, `/pendentes`, `/arquivados`, `/auditoria`, `/configuracoes/*`, `/login`, `/privacy`, `/termos`.

### 3.7 Auditoria e observabilidade de negócio

- `acoes_sara` e `eventos_timeline`: trilha de auditoria de ações da IA.
- `followup_log`: cada disparo (enviado/falhou) para auditoria e idempotência.
- **Auditor cognitivo** (`auditor.ts`, `/auditoria`, ADR-006): avalia a qualidade das decisões da Sara em regime de aprendizado supervisionado, com "gabarito preditivo de visita" (ADR-007).

---

## Parte IV — A Sara e o Salomão (agentes de IA)

### 4.1 Sara — consultora de atendimento

**Papel:** conversar com a família do primeiro contato até a matrícula. **Modelo atual:** OpenAI `gpt-4o` (via `openai` SDK em `sara.ts`). **Saída:** JSON estruturado (`SaraResposta`) com: `resposta` (texto ao usuário), `proxima_coluna_id` + `razao_movimentacao`, `familia_dados`/`crianca_dados` (extração), `transbordo`, `agendar_visita`, `sugerir_matricula`, `resumo_anotacao`, `analise` (camada cognitiva) e `arquivar`.

**Travas anti-alucinação:**
- Base de conhecimento injetada no prompt; endereço fixo; fallback "vou verificar com a equipe" quando não sabe.
- Rede de segurança em código (`sara.ts`) que remove travessão e placeholders (`[nome da criança]`) e barra texto de espera ("A confirmar", "...") gravado como dado real — reação a uma auditoria de corpus de 402 mensagens.
- Nunca inventa escassez; só usa "vagas limitadas" quando é verdade.

**Jornada (resumo — ver `docs/jornada-sara-whatsapp.md`):**
1. **Primeiro contato:** objetivo único — nome + idade da criança. Não oferece visita antes de saber a idade (pode não haver vaga).
2. **Reengajamento** (interessado que não fechou): abertura pessoal → produto → prova real → CTA para visita.
3. **Anti-no-show (coração do sistema):** confirmação imediata (T+0) → lembrete de véspera com confirmação ativa (~18h T-1d) → lembrete do dia (T-3h).
4. **Resgate de no-show:** 2h após a falta, tom acolhedor, nunca cobrança → "Repescagem", **no-show ≠ perda**.
5. **Follow-up pós-visita** (lead quente): traz a objeção não-dita (preço/cônjuge/comparação) à tona.

**Regra de ângulo por tentativa** (`anguloPorTentativa`): cada toque **muda de ângulo** (pergunta fácil → valor antes do pedido → alternativa com saída digna → fechamento elegante), porque repetir a mesma cutucada é o que gera denúncia/bloqueio.

### 4.2 Salomão — disparo de boletos (financeiro)

**Papel:** consumir a fila de boletos montada pelo **Arca** (edge functions do projeto SGEI) e enviar cada boleto pelo WhatsApp da escola (mesma instância Evolution da Sara). **Endpoint:** `POST /api/webhooks/arca/dispatch-boletos` (auth `x-api-key` em comparação de tempo constante; `GET` = health check). **Arquitetura serverless:** responde ao Arca na hora e processa a fila em background via `after()` do `next/server` (`maxDuration` 300s, ~50 itens com pacing). **Idempotência:** a fila é sempre puxada fresca do Arca (só itens `pendente`); itens não confirmados voltam no próximo acionamento; pacing anti-bloqueio de 1–2s com jitter. Ver `docs/SALOMAO-BOLETOS.md`.

---

## Parte V — Modelo de dados

O CRM vive como **schema `crm.*` dentro do projeto Supabase SGEI** (o projeto `escola-crm` antigo está pausado — ver memória do projeto). Entidades principais (de `src/lib/types.ts` e uso no código):

- **familias** — `nome_responsavel`, `telefone`, `email`, `origem`/`canal`.
- **criancas** — `nome`, `idade`, `serie_desejada`, `periodo` (turno).
- **leads** — coração do domínio: `familia_id`, `crianca_id`, `coluna_id`, `responsavel_id`, `score`, `temperatura` (+`temperatura_manual`), `ia_ativa`, campos de follow-up (`followup_count`, `ultimo_followup_em`, `followup_status` ativo/esgotado), sugestão de matrícula, camada cognitiva (`cog_*`), `tags`, `motivo_perda`, `proxima_acao`/`data_proxima_acao`, `entrou_coluna_em`, `arquivado`.
- **mensagens** — `lead_id`, `direcao` (`in`/`out_humano`/`out_ia`), `conteudo`, `tipo_midia`, `url_midia`, `whatsapp_message_id`, `status`/`erro_envio`.
- **funis / colunas** — funil padrão, ordem, cor, `ia_ativa_default`, parâmetros de follow-up.
- **tarefas** — visitas/atividades ligadas a lead e responsável.
- **anotacoes** — notas internas da equipe (alimentam o contexto da Sara).
- **Apoio:** `followup_log`, `acoes_sara`, `eventos_timeline`, `metas_crescimento`, `investimento_canal`, `horarios_visita`, `usuarios`, `integracao_google`, views `v_tarefas_lead`, `v_followup_stats`.

> **Integridade:** a lista canônica de tipos está em `src/lib/types.ts` — este PRD não substitui o schema. Divergência conhecida a corrigir: `Crianca.periodo` no TS usa `matutino/vespertino/integral`, enquanto os turnos reais da escola são `Parcial/Estendido/Integral` (ver Parte VIII, item de correção).

---

## Parte VI — Integrações e automações (crons)

### 6.1 Integrações externas

- **Evolution API** (WhatsApp não-oficial) — canal principal da Sara e do Salomão (`evolution.ts`, `/api/evolution/*`, `/api/admin/evolution-webhook`). Caminho **completo**: persiste família/criança, transbordo, reset de follow-up, mídia.
- **WhatsApp Cloud API** (oficial) — caminho **paralelo e mais fino** (`whatsapp-cloud.ts`, `/api/whatsapp-cloud/*`, `/api/webhook/whatsapp-cloud`, embedded signup, templates). **Dívida técnica:** não persiste família/criança, não faz transbordo nem reset de follow-up — não tem paridade com o Evolution.
- **Google Calendar** — OAuth, push de tarefa, webhook e renovação de watch (`google-calendar.ts`, `/api/google/*`, ADR-006).
- **SGEI** — sistema de gestão escolar; ocupação de vagas e comunicação (`sgei.ts`, `/api/sgei/comunicacao`).
- **Arca** — fila de boletos → Salomão (`arca.ts`).
- **Anthropic SDK** — presente em `package.json`, mas a Sara roda em OpenAI hoje (dívida de limpeza a alinhar).

### 6.2 Crons (agendamento único na Vercel — ADR-008)

> **Mudança desde a v1.0 (ADR-008, 29/07):** o agendamento **não roda mais no GitHub Actions**. Em 23/07 três jobs pararam em silêncio por 6 dias (11 leads vencidos sem toque) porque a migração para a Vercel foi feita pela metade. Decisão: **a Vercel é o único agendador** (`vercel.json`), e os workflows em `.github/workflows/` ficam **apenas como disparo manual** (`workflow_dispatch`) — rede de segurança operável à mão. Dois agendadores ativos = disparo duplicado = risco de bloqueio no WhatsApp.

Agendados hoje em `vercel.json` (fonte de verdade do "o que roda e quando"):

| Cron | Schedule | Função |
|---|---|---|
| `/api/cron/followup` | `*/15 * * * *` | Motor de follow-up: elegibilidade por etapa, backoff, pacing, envio. A cadência de 15 min é obrigatória para não perder o `lembrete_1h` da visita |
| `/api/cron/convites` | `*/20 * * * *` | Convites/reengajamento |
| `/api/cron/auditor` | `0 9 * * *` | Auditor cognitivo da Sara (diário) |
| `/api/cron/google-watch-renew` | `0 8 * * *` | Renova o canal de watch do Calendar (expira em ~30 dias) |
| `/api/cron/google-sync` | `30 8 * * *` | Resync com Google Calendar (rede de segurança do push por webhook) |

Endpoints existentes **fora** do `vercel.json` (só disparo manual ou por evento, não agendados): `/api/cron/evolution-guardiao` (monitor de saúde/restart do Evolution — restart diário e monitor descritos em `docs/GUARDIAO-EVOLUTION.md`) e `/api/cron/auditoria-sara`. **Requer plano Vercel Pro** (o Hobby limita a 1 cron diário, incompatível com `*/15`).

> **Dívida do ADR-008 — parcialmente fechada (26/08):** foi criado o `/api/cron/heartbeat` (`*/30`), que em horário comercial dispara alerta quando há leads ativos mas nenhum envio recente em `followup_log` — exatamente o sinal do silêncio que custou 6 dias. **Limite conhecido:** por ser ele mesmo um cron da Vercel, não cobre a Vercel inteira cair; para isso só um *dead-man switch* externo (decisão em aberto, o ADR-008 rejeitou serviços externos). *Pendente de `vercel --prod` para entrar em vigor.*
>
> **Faxina pendente (2026-08-26):** `.github/workflows/google-sync.yml` ainda carrega `schedule: '*/10'` ativo — resíduo que contraria esta decisão. Verificar nos logs da Vercel se o cron Pro está de fato disparando **antes** de neutralizá-lo (a lição do ADR-008 é nunca desligar o lado antigo sem confirmar o novo).

### 6.3 Motor de follow-up (regras determinísticas — `followup-regras.ts` + `pacing.ts`)

- **Janela comercial:** 8h–20h no fuso de Rio Branco/Acre (`HORA_MIN=8`, `HORA_MAX=20`).
- **Backoff crescente:** intervalo efetivo = base × (count+1); base e teto por etapa vêm da tabela `colunas`.
- **Reset por resposta:** qualquer resposta da família zera o contador e reativa o follow-up.
- **Teto → esgotado:** ao atingir `followup_max`, o lead vira `followup_status=esgotado`; após `DIAS_SILENCIO_PERDIDO=7` sem resposta, candidato a "Perdido".
- **Pacing anti-bloqueio** (`pacing.ts`): teto de **6 envios por rodada** do cron, jitter de **0,8–2,0s** entre envios; número inválido (`exists:false`) → `esgotado` (não reinsiste). Parâmetros ajustáveis documentados em `docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md`.

---

## Parte VII — Arquitetura, segurança e operação

### 7.1 Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres + Auth + Realtime + RLS) · OpenAI `gpt-4o` · dnd-kit · Vitest. Deploy na **Vercel**; crons no **GitHub Actions**.

### 7.2 Deploy e ambiente

Pasta única como fonte de verdade: `D:\Claude\Projects\CRM Escola` (pastas antigas descontinuadas — ver `AGENTS.md`). Git auto-deploy está **quebrado**; deploy é manual: `npx vercel@latest --prod`. Mudanças de banco (Supabase MCP) vão ao ar na hora; mudanças de **código** só após deploy. Não há staging nem CI.

### 7.3 Postura de maturidade (avaliação C-Level 2026-07-02, escala 1–4)

Entrega **2** (deploy manual, sem CI/staging) · Qualidade **1** (sem testes automatizados no início; hoje há alguns testes unitários de regras: `followup-regras.test.ts`, `guardiao-regras.test.ts`, `disponibilidade.test.ts`, `convites.test.ts`, `sara.limparTexto.test.ts`) · Arquitetura **3** (event-driven, domínios claros, ADRs) · Observabilidade **1** (só `console.error`) · Cultura **3** (ADRs, decisões documentadas).

### 7.4 Segurança / LGPD (pontos abertos — detalhe no roadmap)

O sistema guarda **dados de crianças** (dado sensível; LGPD se aplica). Postura atual é frouxa: políticas RLS permissivas ("permite tudo"), app usa service-role (bypassa RLS), view com `SECURITY DEFINER`, `fn_leads_score` exposta via RPC a `anon/authenticated`, e há histórico de secret do Google no Git ainda não rotacionado. São os itens de maior prioridade.

---

## Parte VIII — Roadmap priorizado

Consolida os gaps da avaliação C-Level. Ordem = prioridade.

### Bloco A — Segurança e correções (fazer primeiro)

1. **Rotacionar a chave do Google** e limpar o secret do histórico do Git (crítico — considerar comprometida até rotacionar no Google Cloud + atualizar env na Vercel).
2. **Endurecer 3 itens rápidos de DB/segurança:** recriar `v_tarefas_lead` como `security_invoker`; revogar `EXECUTE` de `fn_leads_score` de `anon/authenticated`; policy explícita (deny) em `integracao_google`.
3. **Corrigir o dropdown de "Período" no LeadDetailModal:** hoje usa `matutino/vespertino/integral`; deve carregar os turnos reais do banco (`Parcial/Estendido/Integral`), como a Sara faz. Bug de dados.
4. **Alinhar chave Arca↔CRM:** garantir `SGEI_API_KEY` (CRM) = `CRM_API_KEY` (Arca) e redeploy, para não repetir a falha 401 de disparo de boletos (22/07).

### Bloco B — Robustez

5. **Migrar para Vercel Pro + CI mínimo** (typecheck + lint no push; preview deploys; remove bloqueios do Hobby por uso comercial e limite de cron).
6. **Índices nas foreign keys quentes** (`leads.familia_id`, `leads.crianca_id`, `mensagens.lead_id`, `anotacoes.lead_id`, `tarefas.lead_id`) e otimizar RLS (`(select auth.fn())` em vez de re-avaliar por linha).
7. **Alerta de falha de cron/webhook** (notificação quando um cron retornar erro) + tela que mostre falhas de `followup_log`/`mensagens`.

### Bloco C — Maturidade

8. **Testes das peças críticas restantes** (função de score, dedupe do webhook) — completar a rede de segurança já iniciada.
9. **Unificar os dois webhooks** (Evolution × WhatsApp Cloud) ou marcar explicitamente o oficial e dar paridade (persistência de família/criança, transbordo, reset de follow-up).
10. **Formalizar governança LGPD:** RLS real, menor privilégio, política de retenção/consentimento para dados de crianças.
11. **Limpeza:** remover/alinhar SDK Anthropic vs OpenAI e o default de modelo na config.

### Bloco D — Crescimento (visão de marketing)

12. **Atribuição de origem/campanha do lead** no ponto de entrada (anúncios click-to-WhatsApp com parâmetro de referência) e **reportar CAC por canal** — hoje `origem` é quase sempre "whatsapp", impossível medir onde investir.
13. **Dashboard de funil** com taxas de conversão por etapa (Capturados→Visita→Matrícula), no-show, tempo de resposta e **taxa de resposta ao follow-up** ligada a desfecho (provar ROI da automação).
14. **Advocacia pós-matrícula:** fluxo de indicação + NPS (em escola, boca a boca é o canal nº 1).
15. **Nutrição com valor** (tour virtual, depoimentos, dica pedagógica) além do reengajamento "vamos agendar?".
16. **Posicionamento afiado** liderado pela Sara (segurança + atenção individual, turma ≤10, ambiente cristão).

---

## Parte IX — Métricas e critérios de sucesso

### 9.1 North Star

**Matrículas fechadas por período** (leads que chegam a "Matriculados"), com CAC por canal como contraponto de eficiência.

### 9.2 KPIs do funil

- **Taxa de comparecimento à visita** = realizadas ÷ agendadas — *o gargalo mora aqui; KPI-chave do anti-no-show.*
- **Taxa de recuperação de no-show** = reagendou e compareceu ÷ no-shows.
- Conversão por etapa: abertura → "SIM" → comparecimento → visita→matrícula.
- **Speed-to-lead:** tempo mediano até a 1ª resposta.
- **Taxa de resposta ao follow-up** e — o gap atual — follow-up **ligado ao desfecho** (resposta/visita/matrícula), não só enviado/falhou.
- **CAC por canal** (depende do item 12 do roadmap).

### 9.3 Critérios de sucesso do produto

O produto está saudável quando: nenhum lead ativo passa mais que um ciclo de backoff sem toque; a confirmação de véspera eleva mensuravelmente o comparecimento; a taxa de falha de envio permanece baixa e estável (sem sinais de bloqueio); e cada real de anúncio é rastreável até uma matrícula.

---

## Parte X — Riscos e decisões em aberto

- **Reincidência de bloqueio do WhatsApp** (canal Evolution não-oficial). Mitigação: pacing, horário comercial, só responder quem procurou, guardião. Risco residual: o canal é intrinsecamente frágil — decisão em aberto é migrar de vez para a Cloud API oficial (exige paridade — item 9).
- **LGPD com dados de crianças.** Postura atual permissiva é o maior risco de conformidade. Bloco C, item 10.
- **Fragilidade de deploy** (manual, sem CI/staging) já quebrou a aba de alertas uma vez. Bloco B, item 5.
- **Dependência de dois modelos/SDKs** sem alinhamento (OpenAI em uso, Anthropic instalado). Baixo risco, alta confusão de manutenção.
- **Decisão em aberto:** unificar ou deprecar um dos dois webhooks de WhatsApp.

---

## Anexo — Glossário

- **Sara** — agente de IA de atendimento (OpenAI gpt-4o).
- **Salomão** — rotina de disparo de boletos (financeiro), via Arca.
- **SGEI** — Sistema de Gestão Escolar Integrado (projeto Supabase que hospeda o schema `crm.*`).
- **Arca** — módulo/edge functions do SGEI que monta a fila de boletos.
- **Evolution API** — gateway WhatsApp não-oficial (canal principal).
- **WhatsApp Cloud API** — API oficial da Meta (canal paralelo, sem paridade).
- **Transbordo** — passagem da conversa da IA para humano.
- **Repescagem** — etapa de recuperação/reagendamento (no-show ≠ perda).
- **Temperatura** — classificação frio/morno/quente derivada do score.
- **ADR** — Architecture Decision Record (`docs/adr/`).

---

*Este PRD reflete o estado do sistema em 2026-08-12 e deve ser revisado a cada ciclo relevante de mudanças. A fonte de verdade do schema é `src/lib/types.ts` + o banco Supabase; a das decisões, os ADRs em `docs/adr/`.*
