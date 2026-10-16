# Maestro Guardião + roteador de intenção (escola-crm)

> Atualização de 2026-10-15. Reativação do escola-crm legado com o supervisor de
> política (Maestro) e o roteador de agente explícitos. Tudo **desligado por
> padrão** — ligar é opt-in por variável de ambiente.

## O que é

- **Maestro Guardião** (`src/lib/maestro/politica.ts`): função pura que decide,
  ANTES de qualquer agente, se a IA responde e por qual rota. Precedência:
  `opt-out` → `atendimento humano forçado` → `IA pausada` → escolha do agente.
- **Roteador** (`src/lib/roteador/decidir.ts`): escolhe o agente de forma
  **determinística** — matriculado (SGEI) + Salomão ligado → Salomão; matriculado
  sem Salomão → humano; lead novo → Sara. Sem chamada de IA. Fallback seguro =
  humano (nunca silêncio nem ação comercial indevida).
- **Opt-out** (`src/lib/maestro/opt-out.ts`): detecta pedido de parar (PT),
  conservador. Pausa a IA e grava `familias.opt_out_em`.
- **Validação de saída** (`src/lib/maestro/validar-resposta.ts`): confere o texto
  do agente antes de enviar (promessa de desconto/bolsa/convênio, valor monetário
  sem preço oficial, fatos proibidos). **Modo sombra por padrão** — só registra.

Tudo é consumido num ponto só: `processarMensagemRecebida` em
`src/lib/atendimento.ts` (o funil comum a todos os webhooks). O roteamento
determinístico que já existia embutido foi **preservado** — a decisão agora é
explícita e testável, sem mudar o resultado quando as flags estão off.

## Flags (variáveis de ambiente — sem migration)

| Variável | Default | Efeito |
|---|---|---|
| `MAESTRO_ATIVO` | *(off)* | `true` liga o gate de opt-out e o log de decisão. Off ⇒ rota idêntica à de sempre. |
| `VALIDACAO_SAIDA_MODO` | `log` | `off` desliga; `log` (sombra) só registra o que vetaria; `ativo` reservado (ver abaixo). |

> `ativo` (bloqueio real da resposta) **ainda não bloqueia** — precisa da lista de
> fatos oficiais do proprietário e do tratamento de registro/transbordo do balão
> vetado. Até lá, comporta-se como `log`.

## Banco (opcional, só para LIGAR)

`docs/sql/2026-10-15-maestro-roteador.sql` — aditiva, **não aplicada**. Necessária
só com `MAESTRO_ATIVO=true` (coluna `familias.opt_out_em` + tabela
`roteador_decisoes`). Sem ela, opt-out persistente e log degradam em silêncio.

## Como ligar (quando o proprietário decidir)

1. Aplicar o SQL acima no Supabase do escola-crm.
2. Setar `MAESTRO_ATIVO=true` na Vercel.
3. Observar `roteador_decisoes` e os logs `[maestro/validacao]` por alguns dias
   (modo sombra) para medir falso-positivo antes de pensar em `ativo`.

## Rollback

Remover as variáveis de ambiente (`MAESTRO_ATIVO`, `VALIDACAO_SAIDA_MODO`) volta
ao comportamento legado na hora — o código com flags off é idêntico ao de antes.
A migration é aditiva; pode ficar no banco sem efeito.

## Decisões pendentes do proprietário

1. **Lista de fatos fixos + regra de preço/vaga** para a validação de saída (ex.:
   preço oficialmente liberado? natação/piscina? bolsas?). Sem isso o gate fica em
   sombra.
2. Manter o **classificador de intenção por LLM desligado** (recomendado — há só 2
   agentes, separados por vínculo SGEI; interface documentada como futura).

## Testes

`src/lib/maestro/*.test.ts` e `src/lib/roteador/*.test.ts` — política (precedência
e paridade com o legado), opt-out (PT, acentos, falsos positivos), roteador e
validação de saída. Rodar: `npm test`.
