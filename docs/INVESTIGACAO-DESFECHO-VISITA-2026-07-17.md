# Investigação — dá para derivar o desfecho "visita agendada" por conversa?

**Data:** 2026-07-17
**Contexto:** pré-requisito da ADR-007 (gabarito preditivo) e da ADR-006 (auditor). Sem rótulo de desfecho confiável, o gabarito não valida nada.
**Fonte:** consulta direta ao Supabase `escola-crm` (`vdtlfzdedrgqhqrevleu`).

---

## Resposta direta

**SIM, o rótulo existe e é limpo. NÃO, você ainda não tem volume para validar o gabarito estatisticamente.**

O gargalo que a mesa previu era real — mas não é onde imaginávamos. Não é "falta o dado de desfecho". O dado é perfeito. O gargalo é **quantidade de exemplos positivos: seis.**

## O que existe (confirmado no banco)

**O funil já modela a visita explicitamente.** Funil "Captação de matrículas": Capturados → Em Atendimento → **Visita Agendada** → **Visita Realizada** → **No Show** → Repescagem → Matriculados → Perdidos.

**Há um evento timestampado de desfecho.** `eventos_timeline.tipo = 'visita_agendada'` carrega `lead_id`, `descricao` ("Sara agendou visita para 2026-07-17T16:30…"), `metadados` (jsonb) e `criado_em`. É o rótulo positivo ideal: ligado ao lead, com hora, e alinhável ao fim da conversa.

**O auditor já existe — mas no grão errado para o ADR-007.** `auditorias_sara` (7 registros) audita **por período** (`periodo_inicio`/`periodo_fim`, `nota_geral`, `achados` jsonb, `sugestoes` jsonb). O ADR-007 exige avaliação **por conversa**, por critério. Não é conflito — é uma camada nova (por conversa) que a auditoria de período passa a consumir. Precisa ser reconciliado no build.

**Já existe uma camada cognitiva parcial.** `leads` tem `cog_probabilidade`, `cog_intencao`, `cog_emocao`, `cog_urgencia`, `cog_proxima_acao`. Ou seja, parte da "probabilidade holística" do ADR-007 **já é estimada hoje**. Vale reaproveitar/validar em vez de reinventar.

## O volume real (a manchete)

| Métrica | Valor |
|---|---:|
| Conversas reais (lead com msg da família) | **29** |
| Positivas (agendou visita) | **6** |
| Taxa-base conversa→visita | **20,7%** |
| Conversas substantivas (≥4 msgs da família) | 22 |
| Positivas entre essas | 6 |

**Seis positivas.** Com isso é **impossível** recalibrar 9 pesos ou medir correlação por critério — qualquer "correlação" seria ruído. O passo "validação estatística" do ADR-007 está **bloqueado por dados, não por design.** Isto é o tipo de coisa que é muito melhor descobrir agora, antes de construir a tela, do que depois.

## Implicação — roadmap ajustado

A ordem original ("rodar sobre o histórico e recalibrar pesos") não é executável hoje. Nova sequência:

**Fase A — agora (uso direcional, não estatístico).**
Rodar o auditor com os **pesos-hipótese** do ADR-007 sobre as 29 conversas. O objetivo NÃO é medir correlação — é gerar o **primeiro dataset rotulado por critério** e achar, qualitativamente, os **gaps dominantes recorrentes** (ex.: "em 4 das 6 perdas, o Convite ficou Ausente"). Isso já orienta melhoria, mesmo sem significância.

**Gate de dados — recalibração só a partir de volume.**
Fixar um limiar explícito: recalibrar pesos e podar critérios (ex.: o #8 "Fluência") **somente com N ≥ ~50 conversas com desfecho e idealmente ≥ 15–20 positivas.** Até lá, pesos permanecem como hipótese e toda leitura é direcional.

**Promoção de regra (ADR-006 Nível 2) — humano forte, não estatística.**
Com esse volume, "regra candidata após N ocorrências" ainda não tem base estatística. Nesta fase, a promoção depende de **julgamento humano explícito** na revisão semanal, não de um threshold automático. O threshold entra quando o volume chegar.

**A rotulagem já roda continuamente** e alimenta tudo (query abaixo).

## Query de rotulagem (gerador do dataset de treino)

Pronta para rodar; produz uma linha por conversa com o rótulo de desfecho:

```sql
select
  l.id as lead_id,
  fam.nome_responsavel,
  c.nome as coluna_atual,
  count(m.id) filter (where m.direcao='in')  as msgs_familia,
  count(m.id)                                as msgs_total,
  max(case when e.tipo='visita_agendada' then 1 else 0 end) as agendou_visita,  -- RÓTULO
  min(m.criado_em) as inicio_conversa,
  max(m.criado_em) as fim_conversa
from leads l
join colunas c   on c.id = l.coluna_id
join familias fam on fam.id = l.familia_id
left join mensagens m        on m.lead_id = l.id
left join eventos_timeline e on e.lead_id = l.id
group by l.id, fam.nome_responsavel, c.nome
having count(m.id) filter (where m.direcao='in') > 0
order by agendou_visita desc, msgs_familia desc;
```

## Higiene de dados (pequenos ajustes)

- **Evento duplicado:** cada agendamento gera ~2 linhas em `eventos_timeline` ("Sara agendou visita para…" + "Visita agendada: …"). Rotular sempre por `count(distinct lead_id)`, não por contagem de eventos (19 eventos = 6 leads).
- **Sinais extras de desfecho disponíveis:** `Visita Realizada` (3) e `No Show` (2) são rótulos mais fortes ainda (visita que aconteceu). Considerar um alvo secundário "compareceu" além de "agendou".

## ⚠️ Segurança (achado colateral, precisa da sua decisão)

O advisor do Supabase apontou: a tabela **`config_ia_backup` está com RLS desligado** — exposta a qualquer um com a anon key. É um backup de config, mas confirme se não tem conteúdo sensível. SQL de correção (NÃO aplicar sem política, senão bloqueia todo acesso):

```sql
ALTER TABLE public.config_ia_backup ENABLE ROW LEVEL SECURITY;
```

Recomendação: se for lixo, dropar a tabela; se for útil, ligar RLS com policy de service_role.

---

## A mesa (curta)

**⚙️ COO —** O gargalo é volume, exatamente como eu disse — só que pior do que eu temia. 6 positivas não gerenciam nada. A boa notícia: a instrumentação é impecável (evento timestampado + funil). Você não precisa construir captura de dado; precisa **rodar mais atendimento**. O KPI-estrela agora tem uma linha de base honesta: 20,7%. É esse número que temos que mover.

**🤖 CAIO —** Com n=6, quem tentar recalibrar peso está fazendo overfitting em ruído. Fase A é direcional e ponto final. E reparem: `cog_probabilidade` já existe — antes de construir a "probabilidade holística" nova, meça se a que já roda presta. Reaproveitar antes de reinventar.

**👔 Vision —** Este é o melhor argumento possível contra o "MA OS" de 500 páginas. Você mal tem dados para o **primeiro órgão**. Construir um sistema operacional autoevolutivo sobre 6 exemplos seria delírio. A decisão de começar pequeno acabou de se pagar: descobrimos o limite real do projeto por R$ 0, em vez de depois de meses de engenharia. Rode o auditor em modo direcional, acumule desfecho, e deixe o dado abrir o próximo passo.

## Prosseguimento

1. **[feito]** Rótulo confirmado (`eventos_timeline.visita_agendada`) e query de treino pronta.
2. **[próximo — em produção neste passo]** Prompt do Auditor (gabarito ADR-007) para rodar sobre as 29 conversas → primeiro dataset por critério (uso direcional).
3. Acumular desfecho até N≥~50 antes de recalibrar pesos.
4. Decidir sobre `config_ia_backup` (RLS ou drop).
