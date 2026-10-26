# Canais de saída — por qual número cada mensagem sai

Ideia trazida do DeskcommCRM (relatório de engenharia reversa dos canais de saída,
22/10/2026): **a conversa responde pelo canal em que ela acontece**. Se esse canal
está fora, o envio falha visível — nunca cai em outro número.

## Peças

| Arquivo | O que faz |
|---|---|
| `src/lib/canais/politica.ts` | Política pura por operação. Sem fallback entre canais. |
| `src/lib/canais/adapters.ts` | Registry `waha` / `cloud` / `evolution`. Canal desconhecido **lança**. |
| `src/lib/canais/estado.ts` | Lê o que está ligado (conta Cloud ativa, WAHA, Evolution, flag) e o `familias.canal_whatsapp` (por `familia_id` ou `telefone_norm`, nunca pelo telefone cru). |
| `src/lib/canais/enviar.ts` | Handler central `enviarPeloCanal`: política → `canalEsperado` → idempotência → portão anti-ban → adapter. Também `transporteDaConversa` e `enviarAvisoInterno`. |
| `src/lib/canais/idempotencia.ts` | `crm.envio_idempotencia`: mesma chave lógica = no máximo um envio. |
| `src/lib/canais/webhook.ts` | Assinatura Meta, segredo, conferência de sessão/instância e trilha `crm.webhook_eventos`. |

## Política por operação

| Operação | Canal | Indisponível |
|---|---|---|
| `resposta`, `followup`, `manual` | `familias.canal_whatsapp`; sem carimbo → Cloud se houver conta ativa, senão o canal de disparos (`WHATSAPP_PROVIDER`) | erro, nada sai |
| `aviso_interno` (Casos, `notificarGestor`, `registrarAlerta`) | mesmo critério, pelo número de aviso; conta no portão como `aviso_interno` (nunca barrado) e não vira mensagem de lead | erro, nada sai |
| `campanha` (Salomão em massa, convites) | canal de disparos (`WHATSAPP_PROVIDER`) | erro |

O carimbo `familias.canal_whatsapp` é gravado em `processarMensagemRecebida` /
`registrarMensagemManual`, pela família, a cada mensagem que entra (ou eco da equipe).

## Carimbo nas mensagens

`crm.mensagens.canal_whatsapp` (`waha|cloud|evolution`) e `canal_ref` (sessão WAHA,
`phone_number_id`, instância Evolution) são gravados na entrada (3 webhooks) e na saída
(Sara, Salomão, follow-up, manual texto/mídia, "Sara responder", retorno de Caso,
retomada, convites). Mensagens anteriores a 22/10/2026 ficam `NULL`.

## Consistência e idempotência

- `canalEsperado`: quem avaliou portão/janela num canal passa esse canal; se o relido
  na hora do envio for outro, `CanalDivergenteError` e nada sai.
- Follow-up usa a chave `followup:<lead>:<trigger>:<toque>:<ultima_interacao_ms>:<balão>`.
  O retry de um cron que caiu no meio não repete o balão que já saiu.

## Webhooks

- **Cloud:** `X-Hub-Signature-256` validado com `WHATSAPP_APP_SECRET` (ou
  `META_APP_SECRET`). Recibos (`statuses`) nunca rebaixam o status.
- **WAHA:** `?secret=` opcional (`WAHA_WEBHOOK_SECRET`). Grupo, story e newsletter são
  descartados antes de tudo. Mensagem de **outra sessão** (ex.: o chip `Salomao-crm`) entra no
  CRM em modo só-registro (`processarMensagemRecebida({ somenteRegistrar })`): sem IA, sem
  mudar `familias.canal_whatsapp`, e um alerta de engajamento em /pendentes para a equipe
  responder pelo próprio chip — a resposta automática sairia pela sessão configurada.
- **Evolution:** segredo opcional (`EVOLUTION_WEBHOOK_SECRET`, `?secret=` ou `apikey`),
  instância precisa ser a de `EVOLUTION_INSTANCE_NAME`. A resposta sai pelo Evolution
  direto — antes saía pela flag (WAHA), outro número.
- Toda mensagem recebida vai para `crm.webhook_eventos` com o resultado
  (`ingerido|duplicado|descartado|rejeitado|erro`) e o payload; retenção de 30 dias
  (pg_cron `canais-retencao-diaria`).

```sql
-- O que entrou e o que foi recusado nas últimas 24h
select canal, resultado, count(*) from crm.webhook_eventos
 where criado_em > now() - interval '1 day' group by 1, 2 order by 1, 2;
```

## Fora de escopo (por ora)

Rodízio de vários números em campanhas, multi-tenant, e gravar a mensagem como
`enfileirado` antes do transporte (cada chamador ainda grava depois de enviar).
