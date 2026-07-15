# ADR-006: Sincronização com Google Calendar via Push Notification (Webhook)

**Status:** Accepted
**Autor:** CTO Architect (conselheiro do projeto) + Aleshan
**Data:** 2026-07-12

## Contexto

A sincronização com o Google Calendar rodava por polling: um cron do GitHub Actions chamava `/api/cron/google-sync` a cada 20 minutos (dentro de `followup-cron.yml`), e um segundo workflow (`google-sync.yml`, descoberto duplicado) chamava a mesma rota a cada 10 minutos — redundância que já foi removida.

O pedido original era reduzir o intervalo para 1 minuto. Isso não é viável: GitHub Actions não garante execução de cron abaixo de ~5 minutos, e mesmo em 5 minutos o consumo de minutos do plano gratuito (2.000/mês) se esgotaria em poucos dias.

## Decisão

Trocar polling por push notifications da Google Calendar API (`events.watch`), nas duas direções:

- **Google → Sistema:** um canal de watch avisa `/api/google/webhook` quando algo muda no calendário; o webhook então puxa só o delta via `syncToken` (sync incremental), não a janela inteira de -30/+180 dias.
- **Sistema → Google:** um trigger no Postgres (`trg_push_google_tarefa`, tabela `tarefas`) dispara uma chamada HTTP assíncrona (via `pg_net`) para `/api/google/push-tarefa` assim que uma tarefa nova é criada — instantâneo, não importa qual das 3 telas criou a tarefa.

O cron via GitHub Actions não desaparece: fica reduzido a 1x/dia (`google-daily.yml`), fazendo (1) renovação do canal de watch (expira em ~30 dias) e (2) um resync completo como rede de segurança, caso alguma notificação se perca.

### Peças novas

- `src/lib/google-calendar.ts` — lógica compartilhada: token, push de uma tarefa, pull incremental/completo, registro/renovação do canal.
- `POST /api/google/push-tarefa` — chamado pelo trigger do Postgres. Autenticado com segredo próprio (`GOOGLE_PUSH_SECRET`, gerado com CSPRNG e guardado no Supabase Vault), separado do `CRON_SECRET`.
- `POST /api/google/webhook` — recebe as notificações do Google. Valida `X-Goog-Channel-Id` + `X-Goog-Channel-Token` contra o canal ativo antes de processar.
- `GET /api/cron/google-watch-renew` — registra ou renova o canal (se faltar <24h pra expirar).
- Colunas novas em `integracao_google`: `channel_id`, `resource_id`, `channel_token`, `channel_expiration` (`sync_token` já existia, mas não era usado — o pull antigo sempre buscava a janela inteira).

## Alternativas consideradas

- **Cron a cada 1 minuto:** rejeitado — GitHub Actions não suporta de forma confiável, e estouraria a cota gratuita de minutos em poucos dias.
- **Cron a cada 5 minutos (piso técnico do GitHub Actions):** seria "quase em tempo real", mas ainda é polling — gasta cota mesmo quando nada mudou, e nunca é instantâneo de verdade. Preterido pela opção de push.
- **Adicionar a chamada de push em cada um dos 3 pontos onde `tarefas` é inserida (client-side):** mais simples de escrever, mas frágil — qualquer tela nova que crie uma tarefa (e há 3 hoje) esqueceria de chamar. O trigger no Postgres cobre automaticamente qualquer inserção, presente ou futura.

## Consequências

**Positivas:** sincronização quase instantânea nas duas direções, sem gastar cota do GitHub Actions em polling; menos chamadas à API do Google (só quando algo muda de verdade); `syncToken` finalmente é usado (a coluna já existia, ociosa).

**Negativas:** mais superfície de código (webhook + trigger + renovação de canal) e uma dependência nova em produção (`pg_net`, que precisa da extensão habilitada e de a rede do Supabase alcançar o Vercel — se um dia isso falhar silenciosamente, o resync diário é quem salva). Canal de watch tem vida limitada e exige renovação — se o cron diário de renovação falhar por vários dias seguidos sem ninguém notar, a sincronização push para (o resync diário ainda cobre o essencial, mas com atraso de até 24h).

**Trade-off aceito:** mais peças móveis em troca de sincronização quase real e zero desperdício de cota — correto para um sistema pequeno onde "quase 1 minuto" era o objetivo real por trás do pedido de "1 minuto".

## Próximos passos

1. Configurar `GOOGLE_PUSH_SECRET` na Vercel (valor gerado e entregue durante a migration).
2. Rodar `/api/cron/google-watch-renew` manualmente uma vez (via `workflow_dispatch` do `google-daily.yml`) para registrar o primeiro canal — antes disso o webhook não recebe nada.
3. Confirmar que `pg_net` está de fato entregando as chamadas (checar `net._http_response` no Supabase se o push parecer não estar chegando).
