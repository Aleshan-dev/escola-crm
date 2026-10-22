# Política Anti-Bloqueio do WhatsApp

**Data:** 2026-07-02
**Contexto:** o WhatsApp aplica **bloqueio preventivo** quando o número tem comportamento parecido com spam (muitos envios em pouco tempo, mensagens idênticas em massa, disparos para quem não te conhece, denúncias). Já enfrentamos isso no piloto. Este documento define os controles técnicos e operacionais para evitar reincidência.

## Princípio

A Sara conversa; ela **não faz disparo em massa**. Toda mensagem automática vai para um lead que **já falou com a escola** — nunca para lista fria. Isso, por si só, elimina o maior gatilho de bloqueio.

O **Salomão**, por outro lado, **faz disparo em massa** (boletos do mês e comunicados) para os pais **matriculados**. O público é quente (conhecem a escola), mas o volume é grande — a escola inteira de uma vez. Aqui o risco não é lista fria, é a **rajada**. Ver a seção "Salomão (disparo em massa)" abaixo.

## Controles técnicos (já implementados)

1. **Só respondemos quem nos procurou.** O follow-up roda apenas sobre leads existentes (que iniciaram conversa no WhatsApp), nunca sobre contatos comprados/frios.
2. **Pacing no envio** (`src/lib/pacing.ts`):
   - **Teto por execução:** no máximo `MAX_ENVIOS_POR_EXECUCAO` (6) mensagens automáticas por rodada do cron (a cada 20 min). O excedente fica para a próxima rodada.
   - **Jitter:** intervalo aleatório (0,8–2,0s) entre um envio e o próximo, para não formar rajada.
3. **Horário comercial:** follow-up só dispara entre 8h e 20h (fuso de Acre).
4. **Backoff crescente:** cada tentativa de reengajamento espera mais que a anterior (24h → 48h → 72h…), e há **teto de tentativas** (`followup_max`) antes de marcar o lead como `esgotado`.
5. **Sem repetição robótica:** o texto é gerado pela Sara a cada vez (contextual), não é o mesmo template copiado para todos — mensagens idênticas em massa são um gatilho forte.
6. **Para de tentar número inválido:** se o WhatsApp responde `exists:false`, o lead é marcado `esgotado` (não reinsiste).

## Salomão (disparo em massa) — controles

Atualizado em **2026-09-03**. Antes desta data, o gatilho "Acionar Salomão" enviava a fila inteira (até 50) num único background, com 1–2s entre cada — uma **rajada**. Reescrito para:

1. **O gatilho só enfileira.** `salomao-trigger-crm` (Arca) monta a fila; o endpoint `/api/webhooks/arca/dispatch-boletos` apenas confirma o recebimento. **Não envia mais na hora.**
2. **Quem envia é o cron** `/api/cron/salomao-dispatch` (a cada 10 min), drenando `boletos_disparo` e `disparos_fila` em **levas pequenas** (`MAX_ENVIOS_SALOMAO_POR_EXECUCAO`, padrão 6) — orçamento **compartilhado** entre boletos e comunicados, para a soma não virar uma leva do dobro.
3. **Espaçamento largo:** **15–45s** aleatórios entre um contato e o próximo (`SALOMAO_JITTER_*` em `src/lib/pacing.ts`), bem acima do 0,8–2s da Sara.
4. **Só no horário comercial** 8h–20h (Acre), **inclusive quando parte de um clique** — comunicado para centenas não pode acordar família de madrugada. Fora da janela, a fila espera a próxima janela.
5. **Cron próprio**, separado do follow-up da Sara: uma leva de 45s de espaçamento estouraria o `maxDuration:30` do follow-up. O do Salomão é `maxDuration:300` (6 × 45s ≈ 270s).
6. **Único drenador = sem duplo-envio.** As filas do Salomão no Arca não têm claim-lock; por isso só o cron drena (o gatilho não envia). Uma execução termina antes da próxima começar. É mais seguro que o desenho antigo, onde um duplo-clique já disparava dois envios concorrentes.
7. **Bypass fechado:** a Edge Function `salomao-dispatch-boletos` (envio direto sem pacing) foi desativada (410).

Parâmetros ajustáveis do Salomão: `MAX_ENVIOS_SALOMAO_POR_EXECUCAO`, `SALOMAO_JITTER_MIN_MS`, `SALOMAO_JITTER_MAX_MS` (`src/lib/pacing.ts`) e a cadência do cron (`vercel.json`). Para a escola inteira sair mais rápido num dia de boletos, suba o teto **com cautela** (e confira que teto × 45s < `maxDuration`).

## Regras operacionais (equipe)

1. **Aquecer número novo.** Nos primeiros dias de um número novo, mande poucas mensagens e aumente aos poucos. Não saia disparando.
2. **Nada de listas frias.** Não importe contatos que nunca falaram com a escola para disparar em massa. Se precisar prospectar ativamente, use os canais/anúncios que fazem a pessoa **iniciar** a conversa (click-to-WhatsApp).
3. **Evite texto idêntico em massa.** Se for mandar algo manual para vários, varie a mensagem.
4. **Responda de verdade.** Conversas reais (ida e volta) melhoram a reputação do número; disparos unidirecionais pioram.
5. **Peça para salvarem o contato** quando fizer sentido — número salvo e conversas ativas reduzem risco de denúncia/bloqueio.

## Monitoramento

- Falhas de envio ficam registradas em `mensagens.status`/`erro_envio` e em `followup_log`. Fique de olho em picos de falha — podem indicar bloqueio começando.
- Sinais de bloqueio preventivo: mensagens "conectadas" mas não entregues, ou erros de envio em sequência mesmo com a instância conectada.

## Se for bloqueado

1. **Pare os envios automáticos** (desligue a Sara nos leads ou pause o workflow do GitHub Actions).
2. O bloqueio preventivo costuma cair sozinho em algumas horas até 24–48h.
3. Ao voltar, **reduza o ritmo** (reduza `MAX_ENVIOS_POR_EXECUCAO`) e aumente gradualmente.
4. Reavalie se houve algum disparo em massa ou lista fria que causou o bloqueio.

## Parâmetros ajustáveis

| Parâmetro | Onde | Padrão |
|---|---|---|
| Máx. de envios por rodada (Sara) | `src/lib/pacing.ts` | 6 |
| Jitter entre envios (Sara) | `src/lib/pacing.ts` | 0,8–2,0s |
| Janela de horário comercial | `src/lib/followup-regras.ts` | 8h–20h (Acre) |
| Intervalo/backoff por etapa | tabela `colunas` (`followup_intervalo_horas`, `followup_max`) | 24–72h / 2–3 |
| Máx. de envios por rodada (Salomão) | `src/lib/pacing.ts` (`MAX_ENVIOS_SALOMAO_POR_EXECUCAO`) | 6 |
| Jitter entre contatos (Salomão) | `src/lib/pacing.ts` (`SALOMAO_JITTER_*`) | 15–45s |
| Cadência do cron do Salomão | `vercel.json` (`/api/cron/salomao-dispatch`) | a cada 10 min |
