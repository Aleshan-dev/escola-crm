# Spec de implementação — Sara: currículo/vaga + Anti-No-Show (Fases 1–3)

> Consolida e substitui os rascunhos `fase1-vespera-e-curriculo-impl.md` e `plano-anti-noshow-sara.md`.
> Tudo verificado contra o código do clone local (`C:\Users\alesh\Documents\escola-crm`) em 2026-07-23.
> Objetivo: subir a **taxa de comparecimento** (KPI-estrela, hoje ≈ 20%) e resolver a regra de currículo,
> tudo num **único deploy**.

## Fatos verificados (base de tudo)
- **Data/hora da visita:** `leads.data_proxima_acao` (ISO), setado em `atendimento.ts:392` quando a Sara
  devolve `agendar_visita.data_hora`. Também cria `tarefas(tipo='visita')` e evento `visita_agendada`.
- **Colunas do funil (`colunas`, campo `nome`/`ordem`):** Capturados → Visita Agendada → Visita Realizada
  → Repescagem → Matriculados / Perdidos. `triggerPorColuna` (followup-regras.ts:27) mapeia coluna→trigger.
- **Gatilho de confirmação já existe:** `confirmacao_visita` (cron `route.ts:188-191`) dispara na véspera
  (`ehVisitaAmanha`, Acre) com guarda de 20h. **É passivo** (só lembra — `followup-regras.ts:105`).
- **Timezone:** tudo Acre (`horaAcre`, `dentroHorarioComercial` 8–20h). Convenção fixa.
- **Contrato `SaraResposta` (sara.ts:47-59):** resposta, proxima_coluna_id, razao_movimentacao,
  familia_dados, crianca_dados, transbordo, motivo_transbordo, agendar_visita, sugerir_matricula,
  resumo_anotacao, analise.
- **Arquivar existe:** `leads.arquivado` (bool). Cron e `marcarPerdidosPorSilencio` já filtram `arquivado=false`.
  Há página `/arquivados`.
- **Movimentação (guard-rails, atendimento.ts:409-454):** sem pular etapa/regressão; Matriculados exige
  humano; Perdidos exige razão. No-show NÃO existe hoje → lead que falta fica em "Visita Agendada" e vira
  "Perdido" por silêncio (7 dias, `marcarPerdidosPorSilencio` route.ts:64).

---

## MIGRATION ÚNICA (aplicar tudo de uma vez)

```sql
-- Fase 1 (opcional, p/ métrica de confirmação e flag de risco)
alter table leads add column if not exists visita_confirmada_em timestamptz;
-- Fase 2 (no-show)
alter table leads add column if not exists no_show_em            timestamptz;
alter table leads add column if not exists reagendamentos_count  int not null default 0;
-- Fase 3 (lembrete do dia + risco)
alter table leads add column if not exists lembrete_dia_em       timestamptz;
alter table leads add column if not exists risco_no_show         boolean not null default false;
```
> Nenhuma coluna nova de Kanban. "Reagendar" é **estado do lead** (`no_show_em`), não coluna do funil —
> evita mexer na ordem/guard-rails. Visibilidade fica via badge/filtro (Fase 3).

---

## PARTE 0 — Regra currículo / vaga → e-mail + arquivar

**Comportamento:** lead falando de vaga/emprego/currículo → Sara orienta a mandar para
`curriculo.guardioes@gmail.com` com a vaga no assunto, **não** trata como matrícula, **não** move funil,
**não** faz transbordo, e o lead é **arquivado** (`arquivado=true`).

### 0.1 `sara.ts` — contrato + prompt
```ts
// type SaraResposta (sara.ts:47): adicionar
arquivar: boolean
motivo_arquivamento: string | null
```
```ts
// parser parsed{} (sara.ts:~328): adicionar
arquivar: parsed.arquivar === true,
motivo_arquivamento: parsed.motivo_arquivamento ?? null,
// e no fallback (sara.ts:~355): arquivar: false, motivo_arquivamento: null,
```
```ts
// JSON de exemplo do prompt (sara.ts:~282): adicionar as chaves
"arquivar": false,
"motivo_arquivamento": "texto ou null",
```
Bloco de regra no system prompt (sara.ts, junto às regras de conduta):
```
## Candidatos a emprego / envio de currículo
Se a mensagem for sobre VAGA DE EMPREGO, trabalhar na escola ou ENVIAR CURRÍCULO
("vocês têm vaga?", "quero trabalhar aí", "posso mandar meu currículo?"):
- Oriente a enviar o currículo para curriculo.guardioes@gmail.com, colocando NO ASSUNTO a vaga de interesse.
- NÃO preencha familia_dados/crianca_dados, NÃO mova o funil, NÃO faça transbordo.
- Retorne "arquivar": true e "motivo_arquivamento": "Candidato a vaga — encaminhado para curriculo.guardioes@gmail.com".
Exemplo de resposta: "Oi! Que bom seu interesse em fazer parte da equipe do Colégio Pequenos Guardiões.
Envie seu currículo para curriculo.guardioes@gmail.com e coloque no assunto a vaga de seu interesse —
assim ele chega direto para a pessoa responsável. Obrigada!"
```

### 0.2 `atendimento.ts` — aplicar o arquivamento (curto-circuito)
Logo após enviar a resposta da Sara e ANTES do bloco `agendar_visita` (~linha 370):
```ts
if (saraResult.arquivar) {
  await supabase.from('leads').update({
    arquivado: true,
    ia_ativa: false,                       // some do cron de follow-up
  }).eq('id', lead.id)
  await supabase.from('acoes_sara').insert({
    lead_id: lead.id, tipo: 'movimentacao',
    conteudo: saraResult.motivo_arquivamento || 'Arquivado: candidato a vaga',
    razao: 'candidato_vaga', sucesso: true,
  })
  await supabase.from('eventos_timeline').insert({
    lead_id: lead.id, tipo: 'movimentacao',
    descricao: saraResult.motivo_arquivamento || 'Arquivado (candidato a vaga).',
  })
  return   // não segue p/ agendar_visita / movimentação / anotação
}
```
> `return` aqui deve encerrar o processamento DESTE lead (verificar o escopo da função ao colar).

---

## PARTE A — Fase 1: confirmação da véspera ATIVA

### A1. `followup-regras.ts` — case `confirmacao_visita` (~linha 104): tornar ATIVO
```ts
case 'confirmacao_visita':
  return `Confirme a visita agendada com ${nome}. Seja calorosa, confirme endereço e horário e ` +
    `PEÇA CONFIRMAÇÃO EXPLÍCITA: que responda "SIM" para garantir o horário. ` +
    `Ex.: "Consegue confirmar que vem? Responde SIM pra mim 💛".${insistencia}`
```

### A2. `atendimento.ts` — capturar o "SIM" (opcional, p/ métrica + risco)
No inbound, se o lead está em "Visita Agendada" e a mensagem é afirmativa:
```ts
const afirmativo = /\b(sim|confirmo|confirmado|vou|pode|isso|ok|blz|beleza)\b/i.test(msgTexto)
if (colunaAtual?.nome === 'Visita Agendada' && afirmativo) {
  await supabase.from('leads').update({
    visita_confirmada_em: new Date().toISOString(),
    risco_no_show: false,
  }).eq('id', lead.id)
}
```

### A3. (Opcional) concentrar o disparo no fim da tarde
No branch `confirmacao_visita` do cron (`route.ts:188`): `if (horaAcre(agora) < 17) continue`.

---

## PARTE B — Fase 2: detecção de no-show + resgate

**Ideia:** para leads em "Visita Agendada", o cron passa a decidir o sub-gatilho pela data da visita
(`data_proxima_acao`), não só "amanhã". Se a visita já passou (+2h) e o lead não foi para "Visita
Realizada" (continua em "Visita Agendada"), é **no-show** → gatilho `resgate_no_show`.

### B1. `followup-regras.ts` — novos triggers + helper
```ts
export type TriggerNome =
  | 'primeiro_contato' | 'confirmacao_visita' | 'followup_pos_visita'
  | 'recuperacao' | 'reengajamento'
  | 'lembrete_dia' | 'resgate_no_show'          // NOVOS

/** A visita já passou há mais de `horas`? (no-show candidato) */
export function visitaPassou(dataVisitaMs: number, agoraMs: number, horas = 2): boolean {
  return dataVisitaMs > 0 && dataVisitaMs + horas * 3600_000 <= agoraMs
}

/** A visita é hoje (Acre)? */
export function ehVisitaHoje(dataVisitaMs: number, agoraMs: number): boolean {
  const v = new Date(dataVisitaMs + ACRE_SHIFT_MS)
  const h = new Date(agoraMs + ACRE_SHIFT_MS)
  return v.getUTCFullYear() === h.getUTCFullYear() && v.getUTCMonth() === h.getUTCMonth() && v.getUTCDate() === h.getUTCDate()
}
```
```ts
// promptPorTrigger — novos cases:
case 'resgate_no_show':
  return `${nome} não compareceu à visita agendada. Seja acolhedora, sem cobrança ("aconteceu, ` +
    `a rotina com criança pequena é corrida"). Ofereça remarcar e peça dois horários que funcionem.${insistencia}`
case 'lembrete_dia':
  return `Lembre ${nome} de que a visita é HOJE. Reforce horário e endereço com entusiasmo ` +
    `("te espero!") e coloque-se à disposição para qualquer imprevisto na chegada.${insistencia}`
```

### B2. `route.ts` — sub-gatilho para "Visita Agendada"
Substituir o branch atual (`route.ts:188-198`) por uma decisão baseada na data da visita:
```ts
const visitaMs = ms(lead.data_proxima_acao)

if (col.nome === 'Visita Agendada') {
  if (!visitaMs) continue

  if (ehVisitaAmanha(visitaMs, agora)) {
    trigger = 'confirmacao_visita'
    if (ultimoFollowupMs > agora - 20 * 3600_000) continue      // guarda 20h (já existia)
    // (opcional A3) if (horaAcre(agora) < 17) continue
  } else if (ehVisitaHoje(visitaMs, agora) && visitaMs > agora && (visitaMs - agora) <= 3 * 3600_000) {
    trigger = 'lembrete_dia'
    if (ms(lead.lembrete_dia_em) > agora - 12 * 3600_000) continue  // 1x por dia
  } else if (visitaPassou(visitaMs, agora, 2)) {
    trigger = 'resgate_no_show'
    // primeira detecção: marca no_show e ZERA o contador p/ dar orçamento novo ao resgate
    if (!lead.no_show_em) {
      await supabase.from('leads').update({ no_show_em: new Date().toISOString(), followup_count: 0 }).eq('id', lead.id)
      count = 0
    }
    if (!estaDevido({ ultimaInteracaoMs, ultimoFollowupMs, entrouColunaMs, intervaloBaseHoras: intervaloBase, count }, agora)) continue
  } else {
    continue   // visita futura (não amanhã, não hoje-3h) → nada a fazer ainda
  }
} else {
  // trigger = triggerPorColuna(col.nome) já calculado; lógica `estaDevido` como hoje
  const devido = estaDevido({ ultimaInteracaoMs, ultimoFollowupMs, entrouColunaMs, intervaloBaseHoras: intervaloBase, count }, agora)
  if (!devido) continue
}
```
> `trigger` deixa de ser `const` (passa a `let`, atribuído por caso). Ao enviar o `lembrete_dia`,
> setar `lembrete_dia_em = now()` no bloco de update pós-envio (junto de `ultimo_followup_em`).

### B3. Reagendamento e teto
Quando a Sara remarca (`agendar_visita.data_hora` futuro) um lead com `no_show_em`, no bloco de
agendamento (`atendimento.ts:371`) adicionar:
```ts
// dentro do if agendar_visita, ao gravar nova data:
await supabase.from('leads').update({
  no_show_em: null,                          // saiu do estado no-show
  reagendamentos_count: (lead.reagendamentos_count ?? 0) + 1,
  risco_no_show: false,
}).eq('id', lead.id)
```
Teto (2 reagendamentos): no branch `resgate_no_show`, antes de disparar:
```ts
if ((lead.reagendamentos_count ?? 0) >= 2) {
  await supabase.from('leads').update({ followup_status: 'esgotado' }).eq('id', lead.id)
  continue   // deixa cair no Perdido por silêncio
}
```
> Adicionar `no_show_em`, `reagendamentos_count`, `lembrete_dia_em` ao `select` do cron (`route.ts:141-144`)
> e ao type `LeadRow` (`route.ts:28-45`).

### B4. Proteger o no-show do "Perdido" prematuro
`marcarPerdidosPorSilencio` (route.ts:64) só age em `followup_status='esgotado'`. Como o resgate reinicia
o contador, o no-show ativo não está "esgotado" → já está protegido. Só vira Perdido depois de esgotar
os resgates + 7 dias de silêncio. **Nenhuma mudança necessária aqui.**

---

## PARTE C — Fase 3: lembrete do dia + flag de risco

- **Lembrete do dia (T-3h):** já coberto pelo case `lembrete_dia` na Parte B2 (setar `lembrete_dia_em`).
- **Flag de risco:** no branch `lembrete_dia`, se `visita_confirmada_em IS NULL`, setar `risco_no_show=true`.
  Surfar na página **/pendentes** (já existe): adicionar seção "Risco de no-show hoje" filtrando
  `risco_no_show=true AND arquivado=false`. Botão "Resolver" zera a flag (mesma UX do transbordo).
- (Opcional) badge no card do Kanban quando `no_show_em IS NOT NULL` ("Reagendar") ou `risco_no_show`.

---

## Regras transversais (mantidas)
- 1 disparo = 1 envio, respeitando `MAX_ENVIOS_POR_EXECUCAO` + `jitterMs()` (pacing anti-bloqueio Baileys).
- Só dentro de 8–20h Acre (`dentroHorarioComercial`, já no topo do cron).
- Tudo em `followup_log` + `acoes_sara` + `eventos_timeline` (auditoria + Auditor Cognitivo mede).
- Canal Evolution/Baileys: texto livre sempre entrega, sem depender de template Meta.

---

## Arquivos tocados (resumo)
| Arquivo | Mudança |
|---|---|
| **migration SQL** | 5 colunas em `leads` |
| `src/lib/sara.ts` | contrato `arquivar`/`motivo_arquivamento` + parser + bloco de prompt (currículo) |
| `src/lib/followup-regras.ts` | +2 triggers, `visitaPassou`, `ehVisitaHoje`, prompt ativo + 2 cases |
| `src/app/api/cron/followup/route.ts` | `LeadRow` + `select` + branch "Visita Agendada" por data + `lembrete_dia_em` no update |
| `src/lib/atendimento.ts` | curto-circuito `arquivar`; captura "SIM"; reset no reagendamento |
| `src/app/pendentes/page.tsx` | seção "Risco de no-show hoje" |

---

## Deploy — de uma vez só
1. **Migration:** aplicar o bloco SQL único (via Supabase `apply_migration`).
2. **Código:** aplicar os 5 patches.
3. **Build local:** `npm run build` (pega erro de tipo antes do deploy — cf. bug histórico do `resumo_anotacao`).
4. **Deploy:** `npx vercel@latest --prod` (auto-deploy git está quebrado).
5. **Smoke test:** agendar 1 visita pra amanhã + 1 no passado (via SQL, `data_proxima_acao`), clicar
   **"Rodar agora"** (Configurações → Manutenção) e conferir: confirmação pede SIM; no-show recebe resgate;
   nenhum envio fora de 8–20h Acre.
6. **Currículo:** mandar "vocês têm vaga?" de um número de teste → Sara encaminha e-mail + lead some (arquivado).
7. **Medir:** acompanhar `public.taxa_comparecimento` por 2–3 semanas (baseline ≈ 20%).

### Ordem de risco (se quiser faseado dentro do mesmo deploy)
Parte 0 (currículo) e Parte A (confirmação ativa) são baixíssimo risco. Parte B (no-show) é a que mexe em
fluxo — testar o branch de "Visita Agendada" com cuidado no smoke test antes de confiar no automático.
