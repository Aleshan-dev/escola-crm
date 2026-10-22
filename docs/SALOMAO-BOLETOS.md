# Salomão — Disparo de boletos (gatilho do Arca)

Data: 22/07/2026 · Feature acionada pelo botão "Acionar Salomão" no Arca.

O Arca monta a fila (boleto ↔ aluno, mensagem, URL assinada do PDF). O escola-crm expõe um endpoint que, ao ser acionado, consome a fila e envia cada boleto pelo WhatsApp da escola (mesma instância Evolution da Sara). Fluxo: `Arca POST → endpoint → disparos_pendentes → Evolution sendMedia (por item) → marcar_enviado (por item)`.

## Endpoint exposto

```
POST https://escola-crm.vercel.app/api/webhooks/arca/dispatch-boletos
```

Se houver domínio customizado em produção (ex.: `crm.pequenosguardioes.com.br`), use-o no lugar — é essa URL que o Arca grava em `CRM_TRIGGER_URL`. Auth: valida `x-api-key` (e, como fallback, `Authorization: Bearer`) contra o segredo compartilhado, em comparação de tempo constante. Health check: `GET` na mesma URL retorna `{ ok: true }`.

## Arquitetura (por que não é o pseudocódigo literal do briefing)

O briefing responde 200 e segue processando no mesmo handler. Isso pressupõe um servidor sempre-ligado; no Vercel (serverless) o processo é congelado assim que a resposta sai, e os envios morreriam pela metade. A rota usa `after()` do `next/server`: responde ao Arca na hora e processa a fila em background respeitando o `maxDuration` (300s — cobre 50 itens com pacing). Consequência de contrato: falha de **configuração** (env faltando) é reportada de forma síncrona com `5xx` (`crm_api_key_missing` ou `evolution_offline`), então aparece na tela do Arca; falha por **item** (número inválido, PDF fora do ar) vai pelo `marcar_enviado(false)`, que é o canal correto — nunca vira 5xx.

Idempotência e resiliência: a lista nunca é guardada localmente — cada acionamento puxa a fila fresca do Arca (só itens `pendente`). Itens não confirmados por timeout continuam pendentes e entram no próximo acionamento. Pacing anti-bloqueio de 1–2s (jitter) entre envios. Falhas parciais registram alerta no painel (`registrarAlerta`, contexto `arca/dispatch-boletos`).

## Gotcha de chave (causa da 1ª falha, 22/07/2026)

No primeiro acionamento real (competência 2026-08, 16 itens), o `salomao-trigger-crm` reportou "avisado", mas nenhum boleto saiu. Diagnóstico: o `POST` ao endpoint do CRM retornou **HTTP 401** (visto nos runtime logs do Vercel) — a fila ficou intacta (`tentativas=0`, tudo `pendente`) e não houve alerta, porque o código nem passou da autenticação.

Topologia das chaves: as três Edge Functions do Arca (`crm-integracao`, `salomao-atendimento`, `salomao-trigger-crm`) validam/enviam o **mesmo** secret project-wide `CRM_API_KEY` (secrets no Supabase são por-projeto, não por-função). O CRM valida a entrada contra `CRM_API_KEY || SGEI_API_KEY` e chama o Arca de volta com `SGEI_API_KEY`. Como a entrada deu 401 com o valor project-wide do Arca, conclui-se que o **`SGEI_API_KEY` do CRM diverge do `CRM_API_KEY` do Arca** — o que quebra também os fluxos de saída (identificar/financeiro/recado e disparos/marcar_enviado).

Correção (uma ação): no CRM (Vercel), setar `SGEI_API_KEY` = valor do secret `CRM_API_KEY` do projeto `sgei` e **redeployar**. Isso conserta entrada (fallback) e saída (arca.ts/sgei.ts) de uma vez, com um único segredo. Verificar reacionando e conferindo `boletos_disparo.status`.

## Variáveis de ambiente

Nada novo é necessário se o valor de `CRM_API_KEY` (do lado do Arca) for igual ao `SGEI_API_KEY` já configurado no CRM — a rota valida contra `CRM_API_KEY || SGEI_API_KEY` e as chamadas de volta ao Arca reusam `SGEI_API_KEY`. Se o Arca usar um segredo diferente, defina `CRM_API_KEY` no CRM com esse valor. Evolution (`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME`) já está ativo (Sara).

## O que passar para o Arca

1. URL do endpoint acima → o Arca grava em `CRM_TRIGGER_URL`.
2. Confirmação de que `x-api-key` é validado: sim (401 quando não confere).
3. Teste ponta-a-ponta com agosto/2026 (16 itens) após o deploy.

## Deploy e teste

Feature é código novo — precisa de `npx vercel --prod`. Depois:
- Health: `GET` na URL deve retornar `{ ok: true }`.
- Fila vazia: acionar com `pendentes: 0` deve retornar 200 sem enviar nada (não é erro).
- E2E agosto/2026: acionar no Arca e conferir no painel de mensagens/alertas se os 16 saíram; falhas por item aparecem como `marcar_enviado(false)` no Arca e como alerta no CRM.

## Arquivos

`src/app/api/webhooks/arca/dispatch-boletos/route.ts` (endpoint), `src/lib/arca.ts` (`arcaDisparosPendentes`, `arcaMarcarEnviado`), `src/lib/evolution.ts` (`evolutionSendMedia`).
