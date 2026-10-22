# Detalhamento de implementação — Fase 1 (véspera) + regra currículo/vaga

> Pseudocódigo de referência. Nomes de arquivos/campos vêm da memória (5–12 dias) —
> **adaptar aos nomes reais** ao abrir o código. Marcado com `// VERIFICAR` onde importa.

---

## PARTE A — Fase 1: Tornar a confirmação da véspera ATIVA

> **Verificado no código (2026-07-23):** o gatilho **já existe** — não é para criar.
> `confirmacao_visita` (`followup-regras.ts:27-32`, `cron/followup/route.ts:188-191`) dispara quando o
> lead está na coluna **"Visita Agendada"**, a visita é amanhã em Acre (`ehVisitaAmanha`) e não houve
> follow-up nas últimas 20h. **Campo da data/hora da visita = `leads.data_proxima_acao`** (gravado de
> `agendar_visita.data_hora` em `atendimento.ts:392`). Timezone já é Acre. Logo, NÃO precisa de
> `lembrete_vespera_em` (idempotência já existe) nem de gatilho/coluna novos.

**O gap (o ganho real):** hoje a confirmação é PASSIVA — o prompt só lembra ("confirme o endereço e o
horário", `followup-regras.ts:105`), não pede resposta nem captura confirmação. Torná-la ATIVA é a
mudança de maior impacto — e é pequena (uma linha).

### A1. Tornar o prompt ativo — `followup-regras.ts`, case `confirmacao_visita` (~linha 104)
```ts
case 'confirmacao_visita':
  return `Confirme a visita agendada com ${nome}. Seja calorosa, confirme endereço e horário e ` +
    `PEÇA CONFIRMAÇÃO EXPLÍCITA: que responda "SIM" para garantir o horário. ` +
    `Ex.: "Consegue confirmar que vem? Responde SIM pra mim 💛".${insistencia}`
```

### A2. (Opcional) Capturar o "SIM" — só p/ flag de risco (Fase 3) e métrica de confirmação
A idempotência do disparo já existe (guarda de 20h + `ultimo_followup_em`). Isto só é necessário se
quiser marcar quem confirmou:
```sql
alter table leads add column if not exists visita_confirmada_em timestamptz;
```
No inbound (`atendimento.ts`), se o lead está em "Visita Agendada" e responde afirmativo, setar
`visita_confirmada_em = now()`. Regex: `/\b(sim|confirmo|confirmado|vou|pode|isso|ok|blz|beleza)\b/i`.

### A3. (Opcional) Concentrar o disparo no fim da tarde
Hoje dispara em qualquer hora 8–20 (Acre) da véspera. Para reconfirmar no fim do dia (melhor timing),
no branch `confirmacao_visita` do cron (~route.ts:188): `if (horaAcre(agora) < 17) continue`.

### A4. Teste
Agendar visita pra amanhã → botão "Rodar agora" (Configurações → Manutenção) → conferir que a mensagem
pede SIM → responder → ver `visita_confirmada_em`. Medir `public.taxa_comparecimento` por 2–3 semanas.

> ⚠️ `confirmacao_visita` conta para o `followup_max` da coluna — uma reconfirmação é 1 mensagem, ok.

---

## PARTE B — Regra: currículo / vaga de emprego → e-mail + arquivar

> "Arquivar" = setar `leads.arquivado = true` (campo já existe; o /pendentes filtra por ele).

### B1. Prompt (`sara.ts` / `config_ia`) — novo bloco

```
## Candidatos a emprego / envio de currículo
Se a mensagem for sobre VAGA DE EMPREGO, trabalhar na escola ou ENVIAR CURRÍCULO
(ex.: "vocês têm vaga?", "quero trabalhar aí", "posso mandar meu currículo?"):
1. NÃO trate como lead de matrícula. Não preencha familia_dados/crianca_dados e não mova no funil de captação.
2. Oriente a enviar o currículo para curriculo.guardioes@gmail.com, colocando NO ASSUNTO a vaga de interesse.
3. NÃO acione transbordo humano.
4. Sinalize para arquivamento (ver campo abaixo).

Exemplo de "resposta":
"Oi! Que bom seu interesse em fazer parte da equipe do Colégio Pequenos Guardiões.
Para se candidatar, envie seu currículo para curriculo.guardioes@gmail.com e coloque
no assunto do e-mail a vaga de seu interesse — assim ele chega direto para a pessoa
responsável. Obrigada!"
```

### B2. Sinalização no contrato JSON da Sara

> **Verificado:** `SaraResposta` (`sara.ts:47-59`) tem 10 campos — resposta, proxima_coluna_id,
> razao_movimentacao, familia_dados, crianca_dados, transbordo, motivo_transbordo, **agendar_visita**,
> **sugerir_matricula**, resumo_anotacao, analise. E **`leads.arquivado` existe** (há página `/arquivados`).

Adicionar um campo ao type + ao JSON do prompt (`sara.ts:~282`) + ao parser (`sara.ts:~328`):
```ts
// no type SaraResposta (sara.ts:47):
arquivar: boolean
motivo_arquivamento: string | null
// no parser (bloco `parsed`, sara.ts:~328):
arquivar: parsed.arquivar === true,
motivo_arquivamento: parsed.motivo_arquivamento ?? null,
```

### B3. Backend `atendimento.ts` — aplicar o arquivamento

```ts
if (respostaSara.arquivar_lead) {
  await arquivarLead(lead.id, respostaSara.motivo_arquivamento);  // set leads.arquivado = true
  await logAcaoSara(lead.id, 'arquivado_vaga', respostaSara.motivo_arquivamento);
  // não seguir com movimentação de funil nem follow-up para este lead
}
```

**Alternativa sem tocar no contrato JSON:** detectar a intenção por palavras-chave no `atendimento.ts`
(regex vaga|emprego|currículo|curriculo|trabalhar) e, nesse caso, responder com o texto fixo do B1 +
`arquivarLead(...)`. Mais simples, porém menos flexível que deixar a Sara decidir pelo contexto.

---

## Ordem sugerida de deploy
1. PARTE B (currículo/vaga) — pequena, isolada, resolve o pedido original.
2. PARTE A (véspera) — testar com 1–2 leads, medir comparecimento.
3. Só então Fases 2 e 3 do `plano-anti-noshow-sara.md`.

Deploy: `npx vercel --prod` (auto-deploy git está quebrado).
