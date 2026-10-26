# Salomão — Fase 1 (atendente de pais matriculados)

Data: 22/07/2026 · Backend: Edge Function `salomao-atendimento` (projeto Supabase `sgei`, Arca)

O Salomão é o irmão da Sara. A Sara atende leads; o Salomão atende responsáveis já matriculados (funil Matriculados). O escola-crm conduz o WhatsApp e a conversa; o Arca decide o que pode ser dito, com duas travas no backend: match único de número (`identificar`) e 2º fator de 3 dígitos do CPF (`financeiro`).

## Arquitetura no escola-crm

`src/lib/arca.ts` é o cliente da Edge Function (identificar / financeiro / recado), reusando `SGEI_API_KEY` (override opcional de URL: `SALOMAO_API_URL`). `src/lib/salomao.ts` contém a persona e o fluxo: o LLM conduz a conversa e extrai intenção + dígitos do CPF, mas a mensagem com títulos e valores é montada por código determinístico a partir da resposta do Arca — dados financeiros nunca saem do LLM. O roteamento fica em `src/lib/atendimento.ts`: família com `ja_responsavel=true` vai para o Salomão quando `config_ia.salomao_ativo=true`; com o switch desligado, vale o comportamento legado (pausa + humano). Uma guarda extra garante que família matriculada nunca cai na Sara. A pausa manual do ADR-005 (equipe responde pelo celular → `ia_ativa=false`) vale igual para o Salomão.

Regras operacionais: máximo de 2 tentativas de CPF (`leads.salomao_cpf_tentativas`); na 2ª falha, recado automático no Arca + transbordo. `identificado:false` ou Arca fora do ar → nada é revelado, recado + transbordo, e a falha vai para o painel de alertas (`registrarAlerta`, contexto `salomao/arca`). Gestor só é notificado quando precisa de humano (recado registrado ou transbordo) — não em toda entrada de matriculado. O cron de follow-up não alcança esses leads (colunas do funil Matriculados têm `followup_intervalo_horas=null`).

Ajustes da revisão CMO/CAIO (22/07/2026): o Salomão se apresenta como atendente virtual na primeira mensagem e nunca finge ser humano; os canais de pagamento da mensagem financeira vêm de `config_ia.salomao_canais_pagamento` (texto livre, editável sem deploy — ex.: "PIX da escola: chave X, ou na secretaria"); sem configuração, o fallback aponta para a secretaria. Pendências da primeira semana em produção: gabarito de auditoria próprio do Salomão (5 critérios binários: não revelou dado sem confirmado, não ecoou CPF, não prometeu desconto, registrou recado quando devia, se apresentou como virtual) e roteiro adversarial de ~10 conversas antes da homologação.

## Rollout (ordem importa)

1. Deploy do código: `npx vercel --prod` (git auto-deploy está quebrado).
2. Só DEPOIS do deploy, ligar o switch e reativar a IA dos matriculados pausados pelo fluxo legado:

```sql
-- 1) Liga o Salomão
update config_ia set salomao_ativo = true where id = 1;

-- 2) Backfill: reativa matriculados pausados pelo fluxo legado ou pelo ADR-005.
--    NÃO toca em leads que um humano marcou para transbordo por outro motivo.
update leads l
set ia_ativa = true,
    precisa_atendimento_humano = false,
    motivo_transbordo = null,
    salomao_cpf_tentativas = 0
from familias f
where f.id = l.familia_id
  and f.ja_responsavel = true
  and l.arquivado = false
  and (l.precisa_atendimento_humano = false
       or l.motivo_transbordo = 'Já é responsável de aluno matriculado (SGEI)');
```

Rollback: `update config_ia set salomao_ativo = false where id = 1;` — sem deploy, volta ao comportamento legado (pausa + humano) na próxima mensagem.

## Fase 2 (aguarda homologação PagBank)

Recurso `segunda_via_pix { whatsapp, titulo_id }` no Arca devolvendo o copia-e-cola PIX. No CRM: nova ação `segunda_via_pix` no JSON do Salomão + envio determinístico do código.
