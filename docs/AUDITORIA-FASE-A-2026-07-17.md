# Auditoria Fase A — primeira rodada real do Auditor da Sara

**Data:** 2026-07-17
**O que é:** aplicação real do gabarito da ADR-007 sobre as conversas reais do banco. Uso **direcional** (n pequeno), não estatístico — conforme o gate de dados do memo de investigação.
**Amostra auditada:** 14 conversas com conteúdo real — as **6** que geraram evento `visita_agendada` + as **8** negativas mais substantivas (≥5 mensagens da família).

---

## Manchete

Três descobertas que mudam o plano, todas contra a intuição do gabarito original:

1. **O alvo "visita agendada" é fraco. O problema real é o No Show.** Das 6 que agendaram, só **2 compareceram** (Sária, Luanny). **3 foram No Show** (Thayná, Delcivania, Regina) e 1 virou Perdido (Suellem). Agendar é fácil; a Sara agenda bem. Fazer aparecer é o gargalo. **O KPI-estrela precisa mudar de "agendou" para "compareceu" (Visita Realizada).**

2. **O "Convite" NÃO é o gap — e o gabarito o supervalorizou (peso 2,0).** A Sara convida para a visita o tempo todo, em quase toda conversa. Todo mundo "passa" nesse critério, então ele **não discrimina** ganhador de perdedor. O que discrimina é o que vem *antes*: Diagnóstico e Construção de Valor — e, acima de tudo, **um critério que nem existe no gabarito: o tratamento da objeção de preço.**

3. **O maior preditor de perda/No Show é o "stonewall" de preço.** A Sara quase sempre recusa dar valor ("não temos tabela única, gostamos de entender primeiro") e usa o convite à visita como desvio da pergunta. As famílias que **receberam um valor real** (Larama: R$1.647; Thayná: R$1.297 "a partir de") se engajaram a sério. As que levaram o stonewall repetido esfriaram ou não compareceram.

## Tabela — score do auditor × desfecho real

| Família | Desfecho real | Faixa (auditor) | Gap dominante | Observação |
|---|---|---|---|---|
| Sária | ✅ Compareceu | Quente | Fluência / Diagnóstico | Pediu preço ~4×, levou stonewall, mas persistiu e veio. Muitas mensagens duplicadas. |
| Luanny | ✅ Compareceu | — (sem conversa) | — | Só 1 msg da família; visita marcada off-line pela equipe. **Rótulo não veio da conversa.** |
| Thayná | ❌ No Show | Quente | Construção de valor / confiança | Recebeu preço, agendou rápido, não veio. Booking raso. |
| Delcivania | ❌ No Show | Morno | Diagnóstico / valor | Agendou logo após qualificação; preço defletido; não veio. |
| Regina | ❌ No Show | Morno | Diagnóstico / valor | Idem: stonewall de preço → agendou → sumiu. |
| Suellem | ⚠️ Perdido | Frio | Convite concreto + precisão | Sara **alucinou endereço** ("Rua Principal, 123"), depois corrigiu. Sem slot concreto. Rótulo "agendada" ruidoso. |
| Lorena | ❌ Não agendou | Morno | Objeção de preço | 18 msgs, muito engajada; stonewall de preço; queria ligação; foi p/ humano. |
| Iasmim | ❌ Não agendou | Morno | Rigidez de horário + preço | 15 msgs; trabalha 8–15h, Sara não acomodou; stonewall. Perda evitável. |
| Larama | ⚠️ Perdido | Morno | Continuidade | **Melhor atendimento da amostra** (deu preço, material). Perdida por timing (mudança em agosto) sem slot reservado. |
| 💕 | ❌ Não agendou | Frio | Objeção de preço | Stonewall + mensagens duplicadas; sem fit de turno. |
| Vitória | ❌ Não agendou | Morno | Objeção de preço | Pediu valor/horário; levou stonewall; em aberto. |
| Danielly | 🚫 fora do escopo | — | — | **Não é lead novo** — mãe matriculada perguntando pagamento de colônia. Poluição. |
| "Família" | 🚫 fora do escopo | — | — | Lixo: códigos de confirmação do Facebook/Instagram. |
| Aleshan Ricciard | 🚫 fora do escopo | — | — | Conversa de **teste** ("Teste de envio", PDF de calendário). |

## Achado colateral crítico: o dataset está poluído

Das 8 "negativas", **3 não são conversas de captação** (matriculada, lixo, teste). Das 6 "positivas", 1 não teve conversa (Luanny) e 1 é rótulo ruidoso (Suellem). Ou seja, o dataset real utilizável é **bem menor que 29** — provavelmente ~20 conversas de captação genuínas, com **~4–5 desfechos limpos de "compareceu"**.

**Implicação:** a primeira coisa que o auditor de produção precisa fazer é **filtrar** para conversas de captação reais (excluir teste, matriculados, lixo de webhook). Sem isso, qualquer métrica nasce contaminada.

## Dois problemas que NÃO são de coaching (vão para engenharia)

Estes não se corrigem com regra de prompt; são bugs. Separá-los é importante — a ADR-006 não deve tentar "aprender" a contorná-los.

- **Duplicação de mensagens.** A Sara envia a mesma mensagem 2–4× seguidas (visível em Sária, 💕, Lorena). Degrada confiança e polui o histórico. **Bug de loop/entrega — CTO.**
- **Alucinação factual.** Endereço inventado no caso Suellem ("Rua Principal, 123"). Endereço é fato fixo; não pode ser gerado. **Guardrail de dados fixos (endereço, horários, valores) — CAIO/CIO.**

## Calibração da camada cognitiva existente (`cog_probabilidade`)

Ela já roda, mas **superprevê**: deu **4 (alto)** para Regina e Delcivania — ambas **No Show** — e para Sária (compareceu). Ou seja, `cog_probabilidade` não distingue "vai agendar" de "vai comparecer". Antes de construir a "probabilidade holística" nova da ADR-007, **conserte ou recalibre a que já existe** contra o desfecho "compareceu". Reaproveitar antes de reinventar.

## Primeira regra candidata (ADR-006 Nível 2)

Com n pequeno, isto é **proposta para julgamento humano**, não promoção automática. Mas o padrão é forte e consistente:

> **Regra candidata #1 — Tratamento de preço.** Quando a família pergunta valor, a Sara não deve fazer stonewall. Deve **ancorar com um "a partir de" real** (como fez com Thayná/Larama) e então conectar ao valor e ao convite. Stonewall repetido correlaciona com esfriamento e No Show em toda a amostra.

E uma mudança de gabarito que o dado já pede:

> **Novo critério proposto — "Objeção de preço bem tratada"** (peso alto). E **rebaixar o peso do "Convite"** de 2,0, já que ele não discrimina. Recalibrar formalmente só no gate N≥~50; mas a direção já está clara.

## A mesa (curta)

**⚙️ COO —** O número mudou de dono. Não é "taxa de agendamento", é **taxa de comparecimento**. 2 de 6 é 33% de comparecimento sobre agendados — esse é o vazamento. E o dataset poluído explica por que qualquer métrica anterior era ruído. Primeiro passo: filtro de conversa real + medir "compareceu".

**🤖 CAIO —** O gabarito estava errado num ponto e o dado provou em 14 conversas: peso alto no Convite, e faltando o critério que mais importa (preço). Isto é exatamente o ciclo de aprendizado funcionando — só que sobre o próprio gabarito, com humano no loop, como desenhado. Não toquem em peso ainda; anotem a direção.

**🔧 CTO —** Metade dos "achados" de comportamento são, na verdade, bugs meus (duplicação, alucinação de endereço). Consertem a engenharia antes de pedir à IA para "aprender" a compensar. Um endereço não pode ser gerado por LLM — é uma constante.

**👔 Vision —** Reparem no que 14 conversas entregaram: um problema de negócio real (No Show), um erro no nosso próprio gabarito (Convite superavaliado), uma regra acionável (preço) e uma lista de bugs. Isso é o Decision Engine provando valor **antes** de qualquer tela, com n=14. É o argumento definitivo contra ter começado pelo "OS".

## Prosseguimento

1. **[KPI]** Trocar o alvo de "visita agendada" para **"visita realizada" (compareceu)**. Ajustar a ADR-007 e a query de rotulagem.
2. **[Dados]** Filtro de conversa de captação real (excluir teste/matriculado/lixo) antes de qualquer métrica.
3. **[Engenharia — CTO]** Corrigir duplicação de mensagens; travar fatos fixos (endereço/horário) contra alucinação.
4. **[Gabarito]** Adicionar critério "Objeção de preço"; marcar "Convite" para rebaixar; recalibrar só no gate N≥~50.
5. **[Sara]** Regra candidata #1 (ancorar preço com "a partir de") — levar à revisão humana antes de aplicar.
6. **[Cognitivo]** Recalibrar `cog_probabilidade` contra "compareceu".
