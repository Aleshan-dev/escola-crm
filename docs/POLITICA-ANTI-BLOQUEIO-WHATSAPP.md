# Política Anti-Bloqueio do WhatsApp

**Data:** 2026-07-02
**Contexto:** o WhatsApp aplica **bloqueio preventivo** quando o número tem comportamento parecido com spam (muitos envios em pouco tempo, mensagens idênticas em massa, disparos para quem não te conhece, denúncias). Já enfrentamos isso no piloto. Este documento define os controles técnicos e operacionais para evitar reincidência.

## Princípio

A Sara conversa; ela **não faz disparo em massa**. Toda mensagem automática vai para um lead que **já falou com a escola** — nunca para lista fria. Isso, por si só, elimina o maior gatilho de bloqueio.

## Controles técnicos (já implementados)

1. **Só respondemos quem nos procurou.** O follow-up roda apenas sobre leads existentes (que iniciaram conversa no WhatsApp), nunca sobre contatos comprados/frios.
2. **Pacing no envio** (`src/lib/pacing.ts`):
   - **Teto por execução:** no máximo `MAX_ENVIOS_POR_EXECUCAO` (6) mensagens automáticas por rodada do cron (a cada 20 min). O excedente fica para a próxima rodada.
   - **Jitter:** intervalo aleatório (0,8–2,0s) entre um envio e o próximo, para não formar rajada.
3. **Horário comercial:** follow-up só dispara entre 8h e 20h (fuso de Acre).
4. **Backoff crescente:** cada tentativa de reengajamento espera mais que a anterior (24h → 48h → 72h…), e há **teto de tentativas** (`followup_max`) antes de marcar o lead como `esgotado`.
5. **Sem repetição robótica:** o texto é gerado pela Sara a cada vez (contextual), não é o mesmo template copiado para todos — mensagens idênticas em massa são um gatilho forte.
6. **Para de tentar número inválido:** se o WhatsApp responde `exists:false`, o lead é marcado `esgotado` (não reinsiste).

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
| Máx. de envios por rodada | `src/lib/pacing.ts` | 6 |
| Jitter entre envios | `src/lib/pacing.ts` | 0,8–2,0s |
| Janela de horário comercial | `src/lib/followup-regras.ts` | 8h–20h (Acre) |
| Intervalo/backoff por etapa | tabela `colunas` (`followup_intervalo_horas`, `followup_max`) | 24–72h / 2–3 |
