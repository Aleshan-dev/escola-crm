# 🚨 Incidente — Follow-up parado e WhatsApp mudo
**Aberto em 29/07/2026 | Severidade: alta | Status: causa identificada, ação pendente do gestor**

---

## Resumo

O WhatsApp da escola **não envia nada desde 28/07 às 21h17 UTC** (18h17 Acre). Não é bloqueio do WhatsApp: é o gateway **Evolution** fora do ar. Hoje (29/07) o cron rodou normalmente e tentou 28 envios entre 12h e 14h15 UTC. **Os 28 falharam.**

Nenhum alerta foi disparado. A escola passou o dia sem responder ninguém e sem saber.

---

## Linha do tempo

| Quando (UTC) | O quê |
|---|---|
| 28/07 21:09 | Última mensagem da Sara entregue com sucesso |
| 28/07 21:17 | Última mensagem humana entregue |
| 28/07 21:17 → 29/07 12:01 | Janela em que o Evolution caiu |
| 29/07 12:01 | Primeira falha registrada (12h UTC = 7h Acre, abertura da janela comercial) |
| 29/07 12:00–14:15 | 28 tentativas, **28 falhas**, 0 alertas |

Zero mensagens recebidas desde 28/07 21:09 também — o que sugere que o webhook de entrada está igualmente afetado, não só o envio.

---

## Causa raiz

### 1. O gateway Evolution está quebrado (causa imediata)

Dois erros distintos, ambos do lado do Evolution:

```
Evolution send falhou (500): Invalid `this.prismaRepository.contact.findMany()`
invocation in /evolution/dist/main.js:275:967
```
Erro **interno do Evolution**, no banco Prisma dele. Não é erro da nossa aplicação.

```
Evolution send falhou (400): {"message":["Error: Connection Closed"]}
```
A instância do WhatsApp **desconectou** (sessão caiu, provavelmente precisa reconectar/ler QR).

### 2. Não existe plano B

Toda falha vem acompanhada de:
```
| template retomada_lead: Sem conta Cloud ativa para enviar template
```
O fallback para a API Cloud da Meta está inativo. Com o Evolution fora, **não há canal nenhum**.

Pior: o próprio sistema de alerta usa `enviarTextoWhatsApp` (Cloud) para avisar o gestor — ou seja, o aviso de que o WhatsApp caiu tentaria ser enviado pelo canal que também está caído. O registro em `alertas_sistema` sobrevive; a notificação, não.

### 3. Falha silenciosa (o que transformou o problema em prejuízo)

`registrarAlerta` só era chamado quando a **query de leads** falhava (`route.ts:174`). Erro de **envio** nunca gerava alerta. Resultado: 28 falhas consecutivas, nenhum aviso, e a `alertas_sistema` sem um único registro hoje.

### 4. Starvation no cron (bug independente, mais antigo)

A query de leads não tinha `ORDER BY`, e o loop tem `break` ao atingir `MAX_ENVIOS_POR_EXECUCAO` (6). O Postgres devolvia ordem arbitrária, então os mesmos leads eram servidos toda rodada e o resto nunca era alcançado.

Evidência no funil da Sara:

| Família | Dias em silêncio | Follow-ups recebidos |
|---|---|---|
| 💕 | 15 | **0** |
| Tst Luziana | 11 | **0** |
| Cesar Campos | 10 | **0** |
| Marcela Martins | 10 | **0** |
| Ana Paula Almeida | 6 | 3 |
| Vitória Milena | 5 | 2 |

Quem estava calado há mais tempo era justamente quem nunca era chamado.

Isso também explica leads eternos no quadro: `deveMarcarPerdidoPorSilencio` exige `ultimo_followup_em` preenchido. Lead que nunca recebeu follow-up tem esse campo nulo e **nunca é encerrado** — havia um lead de 31/01 ainda em Capturados.

---

## Correções aplicadas (pendentes de deploy)

| Correção | Arquivo |
|---|---|
| Alerta quando 3+ envios são tentados e **todos** falham na mesma execução | `src/app/api/cron/followup/route.ts` |
| `ORDER BY ultima_interacao_em ASC` na fila de follow-up: quem está calado há mais tempo é atendido primeiro | `src/app/api/cron/followup/route.ts` |

---

## Ação pendente do gestor (não dá para resolver por código)

1. **Reconectar a instância do Evolution.** Abrir o painel do Evolution, verificar o estado da instância e reler o QR code se necessário. Enquanto isso não acontece, a escola está muda no WhatsApp.
2. **Decidir sobre o fallback Cloud.** Hoje não existe. Com um único canal, qualquer queda do Evolution é um apagão total. Ativar a conta Cloud da Meta como plano B é o que transforma um apagão em degradação.
3. **Conferir 13 famílias** que ficaram sem resposta durante a queda (ver `Capturados` e `Em Atendimento` no funil de captação).

---

## Por que isso é caro

Julho é mês de captação. A auditoria de tom (`AUDITORIA-CMO-TOM-SARA-2026-07-29.md`) mostrou que a janela de resposta é o fator que mais pesa: mãe manda a mesma mensagem para 4 escolas e fecha com quem responde primeiro. Um dia mudo em julho não é um dia perdido, é um lote de leads perdido para o concorrente que respondeu.

E o silêncio durou o dia inteiro só porque ninguém foi avisado. A correção do alerta vale mais, no longo prazo, que a correção da queda: quedas vão acontecer de novo.
