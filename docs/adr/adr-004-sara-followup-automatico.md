# ADR-004: Sistema de Follow-up Automático da Sara

**Status:** Proposed
**Autor:** CTO Architect (conselheiro do projeto) + Aleshan
**Data:** 2026-07-02
**Fase do roadmap:** Fase 4 (Sara como orquestradora)

## Contexto

A Sara CRM movimenta leads no funil de matrícula do Colégio Pequenos Guardiões via WhatsApp. A Fase 4 já implementou a Sara retornando JSON estruturado (`resposta`, `proxima_coluna_id`, `razao_movimentacao`) e guard-rails de movimentação (sem pular etapa, sem regressão, sem ir a "Matriculados" sem confirmação humana, sem ir a "Perdidos" sem motivo).

Falta o componente de **follow-up automático**: reengajar leads que pararam de responder, sem intervenção manual da escola. Um workflow do GitHub Actions (`.github/workflows/followup-cron.yml`) foi commitado como alternativa gratuita ao cron indisponível no plano Vercel Hobby, mas tem erro de sintaxe YAML e nunca rodou de fato.

## Decisão

Construir o follow-up automático como um cron determinístico (GitHub Actions) que decide **quando** agir, delegando à Sara (LLM) apenas a decisão de **o que dizer**. A lógica de elegibilidade, limites e horário comercial fica fora do modelo — em SQL/TypeScript — para ser auditável e previsível.

### Arquitetura

1. **Trigger:** GitHub Actions cron (a cada 15–30 min) chama `POST /api/cron/followup` no Vercel, autenticado por header `Authorization: Bearer $CRON_SECRET`.
2. **Seleção de leads elegíveis:** query no Supabase —
   `status NOT IN ('matriculado', 'perdido')`
   `AND ultimo_contato_at + intervalo_da_etapa(coluna_id) < now()`
   `AND followup_count < max_followups`
   `AND horario_atual BETWEEN 08:00 AND 20:00` (horário comercial, timezone da escola)
3. **Intervalo por etapa:** não é um valor fixo global. Ex.: lead novo sem resposta → 24h; em negociação → 48–72h; carrinho abandonado no formulário → 12h. Configurável em tabela `funil_config` por `coluna_id`.
4. **Guard-rails do follow-up (além dos já existentes na Fase 4):**
   - Máximo de 3–4 tentativas por lead antes de marcar como "frio" (`followup_status = 'esgotado'`) e parar de tentar
   - Backoff crescente entre tentativas (não é sempre o mesmo intervalo)
   - Nunca disparar fora do horário comercial
   - Sara decide o texto, nunca decide se deve mandar — isso é regra determinística do cron
5. **Idempotência:** cada lead tem `ultimo_followup_at` e `followup_count`; cada tentativa gera uma linha em `followup_log` (lead_id, status: enviado/falhou, texto gerado, timestamp). Isso evita envio duplicado se dois runs do cron sobrepuserem e dá auditoria completa do que a Sara mandou sem supervisão humana.
6. **Geração da mensagem:** chamada a `sara.ts` com histórico do lead + etapa atual, pedindo JSON estruturado (mesmo padrão da Fase 4) com o texto da mensagem de follow-up.
7. **Envio:** Evolution API. Falha no envio não incrementa `followup_count` nem marca como enviado — tenta de novo no próximo ciclo.
8. **Observabilidade:** indicador visual no Kanban ("Sara fez follow-up automático") + `followup_log` como fonte de auditoria.

## Alternativas consideradas

- **Vercel Cron nativo:** rejeitado — indisponível no plano Hobby atual.
- **Deixar a Sara decidir quando fazer follow-up (sem cron determinístico):** rejeitado — risco de comportamento imprevisível e mais difícil de auditar/depurar; LLM decidindo "quando" além de "o que" mistura responsabilidades.
- **Follow-up manual (staff dispara):** rejeitado — é exatamente o gargalo que a automação resolve.

## Consequências

**Positivas:** reengajamento consistente sem depender de staff lembrar; auditoria completa de toda mensagem automática enviada; fácil ajustar cadência por etapa sem tocar no modelo de IA.

**Negativas:** mais uma tabela (`followup_log`) e mais complexidade de configuração (`funil_config` por etapa); GitHub Actions cron não é garantido no minuto exato (pode atrasar alguns minutos), o que é aceitável para este caso de uso.

**Trade-off aceito:** determinismo e auditabilidade em troca de um pouco mais de código de orquestração — correto para um sistema que manda mensagens automáticas em nome da escola para pais de alunos.

## Próximos passos

1. Corrigir sintaxe do `followup-cron.yml`
2. Criar tabelas/colunas: `followup_count`, `ultimo_followup_at`, `followup_status` em `leads`; tabela `followup_log`; tabela ou coluna `funil_config` com intervalo por etapa
3. Implementar `/api/cron/followup`
4. Testar com 1–2 leads reais antes de habilitar para todos
