# Plano de implementação — Anti-No-Show na Sara

> Objetivo: subir a **taxa de comparecimento** (KPI-estrela do Auditor Cognitivo, hoje ≈ 20%),
> reaproveitando a infra de follow-up que já existe. Não é reconstrução — é fechar 3 lacunas.
> Filosofia mantida (ADR-004): o **cron decide QUANDO**; a **Sara decide O QUE dizer**.

> ⚠️ Este plano é baseado em memória (5–12 dias). **Verificar contra o código atual** antes de codar,
> em especial os 3 pontos da seção "Verificar antes de começar".

---

## Verificado no código (2026-07-23)

1. ✅ **Data/hora da visita = `leads.data_proxima_acao`** (gravado de `agendar_visita.data_hora` em `atendimento.ts:392`).
2. ✅ **Gatilho de confirmação já existe:** `confirmacao_visita` (coluna "Visita Agendada", véspera via `ehVisitaAmanha`, `route.ts:188`). A Fase 1 **estende** esse gatilho (tornar ativo), não cria novo. Patch em `fase1-vespera-e-curriculo-impl.md`.
3. **Timezone: SEMPRE horário do Acre (UTC-5).** Convenção fixa do projeto — todo o sistema
   (cron, horário comercial 8h–20h, gatilhos) usa Acre, independentemente de a escola ficar no PI.
   O lembrete da véspera (~18h) é em Acre. **Não converter pra Brasília.**

---

## Fase 1 — Reconfirmação ativa da véspera *(maior alavanca, menor esforço — fazer primeiro)*

**O quê:** ~18h do dia anterior à visita, a Sara pede um micro-compromisso: "responde SIM".
É o item que carrega o resultado. Se fizer só uma coisa, é esta.

**Mudanças:**
- **Sem schema novo obrigatório:** o gatilho `confirmacao_visita` já existe e já é idempotente
  (guarda de 20h). Opcional: `visita_confirmada_em` (timestamptz) só p/ capturar quem respondeu SIM.
- **`followup-regras.ts` (case `confirmacao_visita`, ~linha 104):** tornar o prompt ATIVO — pedir
  que o lead responda "SIM". Hoje é passivo (só lembra endereço/horário). Já dispara na véspera
  (`ehVisitaAmanha`, 8–20h Acre) com guarda de 20h — nada a criar no cron.
- **(Opcional) Cron `route.ts:188`:** para concentrar no fim da tarde, `if (horaAcre(agora) < 17) continue`.
- **Inbound (`atendimento.ts`):** se o lead tem véspera pendente e responde afirmativo
  (SIM/confirmo/vou/pode), setar `visita_confirmada_em`. Sem resposta = trata como risco no dia.
- **Prompt (`sara.ts`/`config_ia`):** bloco curto pra Sara reconhecer o contexto de confirmação
  e responder o "SIM" com acolhimento, **sem** mover o funil indevidamente.

**Copy (referência — texto da véspera):**
> Oi, [Nome]! Passando pra confirmar sua visita amanhã, [dia], às [hora] 🙂
> Deixei a sala da [criança] reservada pra você conhecer. Consegue confirmar que vem? Responde **SIM**.

**Como medir:** nada novo. `public.taxa_comparecimento` já é a régua. Marcar como "regra" no Auditor
pra fotografar `kpi_baseline` → `kpi_pos`.

---

## Fase 2 — Detecção de no-show + estado "Reagendar" *(protege o lead quente)*

**O quê:** quem faltou não é perda — é o lead mais quente que você tem. Hoje ele tende a escorregar
pro auto-Perdido. Precisa de um caminho próprio.

**Mudanças:**
- **Detecção (cron):** leads em "Visita Agendada" com `visita_em < now() - 2h` e **sem** evento
  `visita_realizada` = no-show. (A guard-rail que impede marcar "Visita Realizada" antes da hora
  já entrega esse sinal.)
- **Ajustar auto-Perdido:** excluir leads em janela de resgate — no-show não vira Perdido direto.
- **Schema (decisão):** Fase 2 mínima = `leads.no_show_em` (timestamptz) + `reagendamentos_count`
  (int). Coluna "Reagendar" no Kanban fica pra Fase 3 (visibilidade), pra não mexer no board agora.
- **Gatilho de resgate (T+2h):** tipo `resgate_no_show` — Sara gera mensagem acolhedora de
  reagendamento (nunca cobrança); grava log; incrementa contador.
- **Última tentativa (+48h sem resposta):** reaproveita o mecanismo `esgotado` que já existe.
- **Limite:** máx **2 reagendamentos** → depois `esgotado`.

**Copy (resgate):**
> Oi, [Nome]! Senti sua falta hoje 🙂 Sei que a rotina com criança pequena é corrida — acontece.
> Quer que eu remarque? Me diz dois horários que funcionam que eu já deixo separado.

---

## Fase 3 — Lembrete do dia (T-3h) + flag de risco *(polimento)*

- **Lembrete T-3h:** gatilho quando a visita é hoje, faltam ~3h e ainda não enviou (`lembrete_dia_em`).
- **Flag de risco:** visita hoje + `visita_confirmada_em IS NULL` → marcar `risco_no_show` e
  **surfar no /pendentes** pra um toque humano (encaixa no painel que já existe).
- **Opcional:** coluna "Reagendar" no Kanban pra visibilidade da equipe.

---

## Regras transversais (valem pra todas as fases)

- Um disparo = **uma mensagem**, respeitando o pacing anti-bloqueio (split + jitter) — Baileys bane por spam.
- Todos os disparos dentro do horário comercial 8h–20h **Acre** (UTC-5) — convenção fixa do projeto.
- Tudo em `followup_log` / `acoes_sara` / `eventos_timeline` → auditoria + o Auditor Cognitivo mede.
- **Não colidir** com o follow-up pós-visita (esse é pós-comparecimento; o anti-no-show é antes/no lugar).
- Canal atual é **Evolution/Baileys**: sem janela de 24h, texto livre sempre entrega — não depende de template Meta.

---

## Rollout

1. Deploy por CLI (`npx vercel --prod` — auto-deploy git está quebrado).
2. Testar Fase 1 com 1–2 visitas reais antes de ligar geral (padrão ADR-004).
3. Rodar **só a Fase 1** por ~2–3 semanas e ler `taxa_comparecimento` (baseline → pós).
   Volume é baixo → resultado é direcional até acumular desfechos.
4. Se houver lift, seguir pra Fase 2 e 3.

**Expectativa:** reconfirmação ativa costuma levar comparecimento de ~20% para ~35–40%.
Como matrícula acontece majoritariamente pós-visita presencial, isso ≈ dobra o topo real de
conversão sem gastar R$1 a mais em captação.
