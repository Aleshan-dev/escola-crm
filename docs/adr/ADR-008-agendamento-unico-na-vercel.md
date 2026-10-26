# ADR-008: Agendamento único na Vercel (fim do cron em GitHub Actions)

**Status:** Accepted
**Data:** 2026-07-29
**Autor:** Aleshan + painel C-Level
**Relacionado:** ADR-004 (follow-up automático), ADR-006 (Google Calendar por push)

---

## Contexto — o incidente silencioso de 23/07

Em 23/07/2026 três jobs agendados pararam de rodar ao mesmo tempo e ninguém percebeu por
**6 dias**. Descoberto em 29/07.

**Evidência:**

- `followup_log` — último registro em **23/07 18:54**. Nesse momento havia **11 leads
  elegíveis e vencidos** (3 em Capturados, 8 em Em Atendimento), um deles parado desde 18/07
  sem nenhum toque.
- Logs de runtime da Vercel (48h) — **zero requisições** a `/api/cron/followup`.
  `/api/cron/auditor` aparece com 6 hits, ou seja: o cron da Vercel funciona; o path do
  follow-up simplesmente não estava agendado em lugar nenhum.
- `integracao_google.ultimo_sync` — **23/07 18:53**, mesma janela.
  `channel_expiration = 2026-08-14`: o canal de push do Google morreria em silêncio em 16 dias.

**Causa raiz.** Os workflows `followup-cron.yml` e `google-daily.yml` foram desativados com o
comentário *"agora roda 100% na Vercel (ver vercel.json)"* — mas o `vercel.json` só recebeu
`/api/cron/auditor`. As rotas `followup`, `google-watch-renew` e `google-sync` nunca chegaram
ao destino. A migração foi feita pela metade: o lado antigo foi desligado antes de o lado novo
existir.

Um agravante: existia um `followup.yml` **duplicado**, com `schedule: */15` ainda ativo, que
dava a falsa impressão de cobertura. Ele também não executou desde 23/07 — o que reforça que
não dá para confiar no GitHub Actions como infraestrutura crítica deste projeto.

**Por que ninguém foi avisado.** O sistema só registra alerta quando o cron **roda e falha**
(`registrarAlerta('cron/followup', ...)`). Um cron que **não roda** não emite nada. O modo de
falha mais perigoso — silêncio total — era justamente o único não monitorado.

## Decisão

1. **A Vercel é o único agendador.** Todo job periódico vive no `vercel.json`:

   | path | schedule | por quê |
   |---|---|---|
   | `/api/cron/followup` | `*/15 * * * *` | a janela do `lembrete_1h` é de 15 a 90 min antes da visita; cadência maior que 15 min perde o lembrete |
   | `/api/cron/auditor` | `0 9 * * *` | auditoria diária (ADR-006) |
   | `/api/cron/google-watch-renew` | `0 8 * * *` | canal de watch do Google expira em ~30 dias |
   | `/api/cron/google-sync` | `30 8 * * *` | resync como rede de segurança do push |

2. **Requer plano Vercel Pro.** O Hobby limita a 1 cron com execução diária — incompatível com
   `*/15`. O upgrade já era recomendação da avaliação de 02/07 por outros motivos (preview
   deploys, sem bloqueio por uso comercial).

3. **GitHub Actions só como disparo manual.** Todos os workflows de cron ficam apenas com
   `workflow_dispatch`, como rede de segurança operável à mão. Nenhum `schedule` — dois
   agendadores ativos significam disparo duplicado, e no WhatsApp isso é risco de bloqueio.

4. **Regra de processo (a lição que custou 6 dias):** ao mover um job de agendador, o destino
   entra em produção e é **verificado nos logs** ANTES de o origem ser desligado. Nunca o
   inverso. Um comentário de código dizendo "agora roda em X" não é evidência de que roda em X.

## Consequências

**Positivas** — um só lugar para saber o que roda e quando; a verdade do agendamento fica
versionada no repositório junto do código; acaba a dependência de minutos do GitHub Actions.

**Negativas / custos** — custo fixo do plano Pro; concentração de risco na Vercel (se a
plataforma cair, todos os jobs param juntos); os `workflow_dispatch` continuam existindo e
precisam ser lembrados como saída manual.

**Dívida deixada em aberto (a mais importante deste ADR):** continua **não havendo detecção de
cron que não roda**. Este ADR conserta o agendamento, não a cegueira. Enquanto não existir um
heartbeat — algo que dispare alerta quando `max(followup_log.criado_em)` passar de N horas
dentro do horário comercial — o próximo silêncio vai custar outros 6 dias. Recomendação:
próximo item da fila, antes de qualquer feature nova.

## Alternativas consideradas

- **Consertar o GitHub Actions:** rejeitado. `*/15` são ~2.900 min/mês; o plano free de repo
  privado dá 2.000 — quebraria todo mês por volta do dia 20, que é compatível com o que se
  observou. Além disso, o `followup.yml` tinha schedule ativo e ainda assim não rodou: a
  confiabilidade não está estabelecida.
- **Cron externo (cron-job.org):** viável e gratuito, com resolução de 1 minuto. Rejeitado por
  adicionar mais um serviço fora do repositório ao inventário — exatamente o tipo de
  configuração invisível que causou este incidente.
- **Reduzir a cadência para 30–60 min para caber no free tier:** rejeitado. Quebra o
  `lembrete_1h`, que é a peça central do anti-no-show — e comparecimento é o KPI-estrela
  (ADR-007).
