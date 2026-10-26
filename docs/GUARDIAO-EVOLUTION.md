# 🛡️ Guardião do Evolution — restart diário e monitor de saúde

**Criado em 29/07/2026**, em resposta ao `INCIDENTE-FOLLOWUP-PARADO-2026-07-29.md`: o gateway caiu por volta das 18h de Acre e a escola ficou **muda no WhatsApp até o dia seguinte, sem um único alerta**.

---

## Antes de mais nada: isto é paliativo

Reiniciar todo dia **não conserta** o Evolution. Trata sintoma. O que o restart diário faz é limitar o estrago de um serviço que já se provou instável, enquanto a causa real (memory leak, sessão que expira, bug do Prisma) não é resolvida.

O que realmente reduz o risco, em ordem de impacto:

1. **Fallback pela API Cloud da Meta.** Hoje o canal é único: se o Evolution cai, não há plano B. Toda falha registrada no incidente vinha com `Sem conta Cloud ativa para enviar template`. Com fallback, apagão vira degradação.
2. **Monitor de saúde** (implementado aqui). Detecta em 15 min em vez de no dia seguinte.
3. **Restart preventivo diário** (implementado aqui). O que você pediu.

O item 1 continua aberto e é o que mais vale.

---

## O que foi implementado

### Caminho principal: cron da Vercel

Rota única `/api/cron/evolution-guardiao`, agendada duas vezes em `vercel.json`:

| Agendamento | Cron (UTC) | O que faz |
|---|---|---|
| Restart diário | `0 11 * * *` = **06:00 Acre** | Chama a rota com `?modo=diario`. Reinicia sempre, mesmo saudável. Duas horas antes de a janela de follow-up abrir (8h Acre), para a instância estar fresca e já verificada quando as mensagens começarem a sair. |
| Monitor de saúde | `*/15 * * * *` | Sem parâmetro. Consulta `connectionState` e só reinicia se a instância estiver caída. |

O restart diário é identificado **só** pelo parâmetro `?modo=diario`, nunca pela hora. Às 11:00 UTC os dois agendamentos disparam juntos; se a janela fosse inferida pela hora, ambos pediriam restart antes de o cooldown ser gravado.

> Como não há agendamento no GitHub Actions, o cron `0 11 * * *` da Vercel é o **único** caminho automático do restart diário. Se ele falhar, o monitor de 15 min ainda cobre a queda (só não faz a prevenção).

**Todo agendamento deste projeto fica na Vercel**, nunca no GitHub Actions — é a convenção já adotada em `followup-cron.yml` e `google-daily.yml`, para não consumir minutos do Actions.

### Disparo manual: GitHub Actions

`.github/workflows/evolution-guardiao.yml` **não tem agendamento**, só `workflow_dispatch`. Ele reinicia via **Railway CLI** e verifica a reconexão por até 3 minutos, falhando ruidosamente se o WhatsApp não voltar. Serve para dois casos:

1. **Testar se a sessão sobrevive ao restart** antes de confiar no agendamento diário (ver a seção de risco abaixo). É o uso mais importante.
2. Reiniciar na mão quando o painel do Railway não estiver acessível.

---

## Máquina de decisão

Implementada em `src/lib/guardiao-regras.ts` (pura, sem rede, coberta por 16 testes).

| Estado da instância | Janela diária? | Ação |
|---|---|---|
| `open` | não | **nada** |
| `open` | sim | **restart_diario** |
| `close` | qualquer | **restart_recuperacao** |
| `desconhecido` (API fora) | qualquer | **restart_recuperacao** |
| `connecting` | qualquer | **aguardando_conexao** |
| qualquer, com restart há < 30 min | qualquer | **cooldown** |

Duas regras que evitam que a cura vire doença:

- **`connecting` nunca dispara restart.** A instância está subindo. Derrubá-la de novo só atrasa a volta. Vale inclusive na janela diária.
- **Cooldown de 30 minutos vence tudo, inclusive o restart diário.** Sem isso, uma instância que sobe quebrada seria reiniciada a cada 15 minutos para sempre. Com isso, o guardião tenta uma vez, espera, e se continuar quebrada registra alerta pedindo intervenção manual.

---

## ⚠️ O risco que você precisa avaliar antes de ligar

**Reiniciar o Evolution pode derrubar a sessão do WhatsApp.**

O Evolution guarda o estado de autenticação da sessão. Se no seu setup esse estado estiver num **volume persistente ou no Postgres**, o restart reconecta sozinho e está tudo bem. Se estiver em **disco efêmero do container**, cada restart exige **reler o QR code à mão** — e aí um restart diário significa reconectar o WhatsApp todo santo dia às 6h. Seria muito pior que o problema.

**Como testar sem arriscar:** dispare o workflow manualmente uma vez (aba Actions → "Guardião do Evolution" → Run workflow) e veja se o passo "Verificar se o WhatsApp reconectou" passa. Se passar, a sessão sobrevive e o agendamento diário é seguro. Se falhar, **desative o cron diário** (deixe só o monitor de saúde) e trate a persistência da sessão antes.

Enquanto isso não for testado, o restart diário é o passo mais arriscado desta entrega.

---

## Configuração necessária

### Variáveis na Vercel

| Variável | Onde achar |
|---|---|
| `RAILWAY_API_TOKEN` | railway.com/account/tokens (conta ou workspace) |
| `RAILWAY_SERVICE_ID` | No projeto Railway, `Cmd/Ctrl+K` → copiar Service ID |
| `RAILWAY_ENVIRONMENT_ID` | Mesmo lugar → copiar Environment ID |

Sem elas o guardião **não quebra**: ele detecta a queda, registra alerta dizendo que o Railway não está configurado, e devolve 503. Ou seja, você ganha o monitoramento mesmo antes de configurar o restart.

### Secrets no GitHub

`RAILWAY_TOKEN`, `RAILWAY_SERVICE_NAME`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `CRON_SECRET`.

### Banco

Tabela `sistema_estado` (chave/valor) — **já criada** via migração `criar_sistema_estado`. Guarda o timestamp do último restart para o cooldown sobreviver entre invocações serverless. RLS ligada, só `service_role` escreve.

---

## Como saber que está funcionando

```sql
-- Alertas do guardião nos últimos dias
select criado_em, contexto, mensagem
from alertas_sistema
where contexto = 'cron/evolution-guardiao'
order by criado_em desc limit 20;

-- Quando foi o último restart automático
select valor, atualizado_em from sistema_estado where chave = 'evolution_ultimo_restart';
```

Teste manual da rota:
```
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://escola-crm.vercel.app/api/cron/evolution-guardiao
```
Resposta esperada com tudo saudável: `{"hora_acre":14,"estado":"open","saudavel":true,"acao":"nada","reiniciado":false}`

---

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/guardiao-regras.ts` | Decisão pura (cooldown, janela, estados) |
| `src/lib/guardiao-regras.test.ts` | 16 testes, incluindo a reprodução do incidente de 28/07 |
| `src/lib/railway.ts` | Cliente GraphQL do Railway (restart sem rebuild) |
| `src/lib/evolution.ts` | `evolutionConnectionState()` |
| `src/app/api/cron/evolution-guardiao/route.ts` | Orquestração e alertas |
| `.github/workflows/evolution-guardiao.yml` | Disparo manual (sem agendamento) |
| `vercel.json` | Os dois agendamentos |
