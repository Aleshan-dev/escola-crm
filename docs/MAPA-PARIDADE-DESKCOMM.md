# Mapa de paridade + Plano de cutover — CRM Escola → DeskcommCRM

> **Data:** 2026-09-28
> **Origem:** evidência de código das duas bases (`D:\Claude\Projects\CRM Escola` e um snapshot de `DeskcommCRM`), + verificação do repositório upstream `https://github.com/melgarafael/DeskcommCRM`.
> **Objetivo:** modernizar o sistema no ar (segue 1 escola), adotando o DeskcommCRM como base, sem perder função.
> **Execução:** o passo a passo da primeira fase está em [CUTOVER-FASE0-RUNBOOK.md](./CUTOVER-FASE0-RUNBOOK.md).

---

## ⚠️ Verificação do git (o que muda a base do plano)

A pasta local `CRM ESCOLA 2` **não é repo git** — é um snapshot morto de **26/ago/2026**. O repositório real, `melgarafael/DeskcommCRM`, está **~1 mês à frente e é um projeto open-source ativo**:

- HEAD `main` de **hoje** (`ed8f997`, 2026-09-28), **126 branches**, PRs em **#1854**, vários contribuidores, **389 migrations** (eram 164 no snapshot).
- Já traz, além do snapshot: **agenda + Google Calendar/Google Meet**, propostas comerciais → PDF, embeddings multi-provedor (OpenRouter), i18n.
- ⚠️ **O upstream REMOVEU o vertical de escola** que o snapshot de agosto tinha: `settings/escola`, `schemas/students`, `crm_students` **sumiram da main** e o `supabase/baseline.sql` **não tem nenhuma tabela de aluno/turma/matrícula**. O DeskcommCRM de hoje é um **CRM comercial genérico**.

**Consequências:**
1. A base do projeto é um **fork da `main` atual**, não o snapshot. Estratégia: **fork + rebase**, com as customizações de escola em overlay isolado.
2. **Google Calendar sai de "ausente" para "já existe"** (com Meet) — reduz o custo do "sem perder função".
3. **Cobrança/boleto (Salomão) continua ausente** na main → decisão de re-apontar pro SGEI segue de pé.
4. **O domínio de escola (aluno/turma/matrícula/responsável) é 100% overlay nosso** — não dá mais pra apoiar em `crm_students`. O motor genérico (inbox, pipelines, follow-up, agenda, pacing, LGPD, agent-engine, judge) continua vindo de graça; só o modelo escolar é nosso.
5. O mapa abaixo já corrige Google Calendar **e** o domínio de escola; as linhas 🟡 e as ausências devem ser **re-validadas ao clonar a main**.

---

## Mapa de paridade

**Legenda:** ✅ existe (igual/melhor) · 🟡 reexpressar/reconfigurar · 🔴 ausente, portar · ➕ ganho novo · 🔌 toca SGEI · 📱 toca WhatsApp

### 1) Já coberto — porte barato

| Função (no ar) | Evidência nossa | No DeskcommCRM | Esforço |
|---|---|---|---|
| Kanban / funil de leads | `kanban/`, `dnd-kit`, `FunilMatriculados` | `lib/pipelines`, ~299 arq. board | Baixo-médio |
| Chat / inbox WhatsApp | `chat/`, `ChatPopup`, `atendimento.ts` | ~444 arq. inbox/conversa | Baixo |
| Agendamento + disponibilidade | `agendamentos/`, `disponibilidade.ts` | `api/v1/agenda/*`, `attendant_availability` | Baixo |
| Anti-bloqueio / pacing / janela 24h | `pacing.ts`, `janela.ts` | `guardrails/messaging-window`, `pacing_ledger` | Baixo |
| Mídia (áudio/imagem/transcrição) | `midia.ts` | workers `media-derive`/`media-persist` | Baixo |
| Templates WhatsApp | `criar/listar-template` | `channels/templates`, `meta_templates` | Baixo |
| WhatsApp Cloud (oficial) 📱 | `whatsapp-cloud.ts` | `channels/official`, `meta-cloud.ts` | Médio |
| WAHA (não-oficial) 📱 | `waha.ts` | adapter WAHA nativo | Baixo |
| **Google Calendar / agenda** | `google-calendar.ts`, `/api/google/*` | **existe na `main`** (agenda + Google Meet: `deliver/resend/retry`, `resolver`, `updateGoogleOAuth`) | Baixo (config) |

### 2) Existe, mas precisa reexpressar (🟡)

| Função | Evidência nossa | No DeskcommCRM | Esforço |
|---|---|---|---|
| Sara (agente IA) | `sara.ts` (34KB), `/api/sara/*` | agent-engine + `ai-response-worker`, agente **versionado** | Médio |
| Auditor cognitivo da Sara | `auditor.ts`, `auditoria.ts` | `flywheel_judge_verdicts`, `flywheel-judge-live` | Médio |
| Motor de follow-up | `followup-regras.ts` | `followup_enrollments` (pause/resume/snooze/rollback) — **melhor** | Médio |
| Pós-visita 5 toques (D0/D3/D7/D10/D14) | `POS_VISITA_TOQUES_HORAS` | expressável como um `followup-flow` | Baixo-médio |
| **Responsáveis (pais)** | `responsaveis/` | `contacts` (genérico) **+ modelo aluno↔responsável do overlay** (não existe mais no upstream) | Médio |
| Matrícula em 2 funis por série | `FunilMatriculados` | pipelines (genérico) **+ criar modelo de alunos/turmas/matrícula como migration do overlay** | Médio-alto |
| Evolution (canal de disparos) 📱 | `evolution.ts`, `guardiao-regras.ts` | só WAHA + Meta; papel coberto por WAHA, provider não portado | Médio |
| Convites de matrícula (ARCA) 🔌 | `convites.ts`, `arca.ts` | `webhook_lead_captures` (papel genérico); parte ligada ao SGEI a portar | Médio |
| Disparos / reengajar / alertas engajamento | `disparos.ts`, `/reengajar`, `alertas.ts` | flows + `incidents`/health (parcial) | Médio |

### 3) Ausente — precisa portar (🔴)

| Função | Evidência nossa | No DeskcommCRM | Esforço |
|---|---|---|---|
| **Salomão — régua D-3…D+15** 🔌 | `salomao.ts`, `salomao-dispatch.ts`, `boletos.ts`, `arca.ts` | inexistente | **Alto** (decisão: re-apontar pro Edge Function do SGEI) |
| **Integração SGEI (financeiro)** 🔌 | `sgei.ts`, `/api/sgei/comunicacao` | inexistente (externo) | **Alto** — mas umbilical read-only fino (176 linhas) |
| Idade da criança (anos + meses) | `idade.ts` | campo no modelo de alunos do overlay | Baixo |

### 4) ➕ Ganhos que o DeskcommCRM traz

LGPD by-design (export/redact workers) · migrations versionadas (a "tripla") · workers isolados · RAG/KB versionada · agente versionado com publish/rollback · Sentry · testes de invariantes/e2e · **Google Meet, propostas comerciais→PDF, embeddings multi-provedor (upstream vivo)**.

### 5) Peso morto para 1 escola

Multi-tenant/RLS, painel de tenants, onboarding de org, billing/suspensão. (O kit self-host passa a ser útil pela decisão de infra.)

### Placar

| Bucket | Qtd |
|---|---|
| ✅ Já coberto | **9** |
| 🟡 Reexpressar | **9** |
| 🔴 Portar | **3** (2 Alto: Salomão, SGEI) |
| ➕ Ganho novo | 7 |

**Leitura:** o motor genérico (inbox, pipelines, follow-up, agenda, pacing, LGPD, agent-engine, judge) continua vindo de graça. O custo do "sem perder função" concentra-se em **2 itens de esforço alto** (Salomão e SGEI, ambos 🔌) **+ o domínio de escola inteiro (aluno/turma/matrícula/responsável), que agora é overlay nosso** — o upstream não fornece mais. Isso torna o rebase mais previsível (não disputamos o domínio com o upstream), mas o overlay é maior do que parecia.

**Confiança:** alta nas linhas com evidência de arquivo. Classificadas por papel (a revalidar linha-a-linha ao clonar a main): **Convites/ARCA**, **Disparos**, **Evolution**.

---

## Plano de cutover strangler

### Decisões travadas
1. **Infra:** self-host Docker/Caddy na **VPS do Google (GCP), o mesmo box onde o WAHA já roda**. Sai da Vercel. Staging convive com a produção na VPS com isolamento; WAHA reusado via sessão dedicada ao chip de teste (ver runbook).
2. **Salomão:** re-apontar pro Edge Function do SGEI na 1ª fase; reescrita nativa depois.
3. **WhatsApp:** chip de teste separado para staging (parallel-run real antes do corte).
4. **Upstream:** fork + rebase de `melgarafael/DeskcommCRM`; customizações em overlay isolado.

### Princípios
- Base = **fork da `main`** (nunca o snapshot de agosto).
- **Overlay separado** (SGEI, Salomão, dois-funis, campos de escola) → rebase barato; correção genérica vira PR ao upstream.
- **SGEI é fonte de verdade financeira até o fim** — só leitura, nunca escrita.
- **Sem big-bang**: cada vertical vira quando verificado em staging.
- **Legado no ar** como rollback até a Fase 8.

### Fases

| Fase | Escopo | Verificação |
|---|---|---|
| **0 — Fundação** | Fork + clone da `main`; branch `escola/main` + overlay; Docker/Caddy; Supabase novo + migrations; Redis; Sentry; CI `gov:verify`; **re-baseline do mapa** | `pnpm build` + `gov:verify` verdes; `/api/v1/health` 200 |
| **1 — Umbilical SGEI** | Portar `sgei.ts` (envs + `normalizarCelularBR`, `identificarResponsavel`, `getOcupacaoDireta`, `checkLead`); ligar a `contacts` + ao modelo de alunos do overlay (criado na Fase 4) | responsável real resolve nome/turma/ocupação = legado |
| **2 — Inbox + Sara (chip de teste)** | WAHA + Meta Cloud; portar persona/prompt/treino da Sara p/ agente versionado; auditor → flywheel-judge | conversa ponta a ponta; tom, janela 24h, pacing; judge audita |
| **3 — Follow-up + pós-visita** | Réguas (incl. 5 toques) → `followup-flows` + enrollments | `test:unit`; simular "Visita Realizada" → 5 toques na cadência; transbordo→alerta |
| **4 — Domínio de escola + matrículas 2 funis** | **Criar o modelo de alunos/turmas/matrícula/responsável como migrations do overlay** (o upstream removeu — não existe mais `crm_students`); dois funis → pipelines; portar `idade.ts` (anos+meses) | lead cai na série certa; métricas cruzam os dois funis |
| **5 — Salomão (re-apontar)** | Reconectar ao Edge Function de cobrança do SGEI; "matriculado pausado = silêncio" (ADR-005); botão "responder agora" | vencimento de teste dispara régua; sem dupla-cobrança |
| **6 — Google Calendar** | **Adotar/configurar** o que já existe na main (OAuth, Meet); cobrir só o gap fino | OAuth conecta; evento + Meet; watch renova; webhook reflete |
| **7 — Corte do número + go-live** | Migrar número de produção; DeskcommCRM assume webhook; congelar legado | 1ª mensagem real responde pelo novo; monitorar 48h; rollback por webhook |
| **8 — Descomissionar legado** | Após 2 semanas sem incidente, aposentar Vercel/crons antigos; manter SGEI vivo | — |

### Migração de dados

| Legado (schema `crm`) | DeskcommCRM |
|---|---|
| leads / funil | `lead_state` + `crm_lead_scores`/`crm_lead_risk_states` + `contacts` + pipelines |
| mensagens / timeline | conversations + messages |
| matrículas 2 funis | pipelines + **modelo de alunos/turmas do overlay** (criado na Fase 4) |
| responsáveis | `contacts` + **relação aluno↔responsável do overlay** |
| config_ia / followup_* | `followup_flow_versions` + `followup_enrollments` |
| **SGEI (turmas/alunos/responsáveis/ocupação/boletos)** | **permanece externo, read-only — NÃO migrar** |

ETL one-shot por vertical, validado por contagem + amostragem antes de cada corte.

### Preservação do WhatsApp 📱
- Staging inteiro no chip de teste (Fases 2–6).
- Número de produção só migra na Fase 7, em janela coordenada, rollback via re-apontamento de webhook.
- Reusar regras de 9º dígito por DDD (`normalizarCelularBR`, check-exists) — não recriar o bug "no LID found".

### Manutenção contínua do fork
- Rebase da upstream (ex.: quinzenal) com `gov:verify` + e2e como gate.
- Triar o que vem da upstream (propostas, embeddings, i18n) vs peso morto multi-tenant.
- Devolver correções genéricas como PR reduz a dívida de merge.

### Riscos
- **Upstream vivo / deriva de rebase** → overlay isolado + rebase frequente + CI verde.
- **Umbilical SGEI (🔌)** → baixo (read-only fino); testes de contrato do `crm-integracao`.
- **Corte do número (📱)** → janela coordenada + rollback por webhook + parallel-run prévio.
- **Deriva da Sara** → validação lado-a-lado antes da Fase 7; agente versionado permite rollback.
- **Base defasada** → nunca codar contra o snapshot; sempre contra o fork da main.

### A aprofundar antes de codar
Abrir comportamento linha-a-linha de **Convites/ARCA**, **Disparos** e **Evolution** (classificados por papel, não por comportamento) — no início das Fases 3/4.
