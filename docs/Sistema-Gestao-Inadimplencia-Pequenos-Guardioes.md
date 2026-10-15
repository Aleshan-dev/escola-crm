# Sistema de Gestão de Inadimplência — Colégio Pequenos Guardiões

*Elaborado em 27/07/2026 · Baseado nos dados reais do sistema Arca (SGEI) · Rio Branco – AC*

---

## Diagnóstico — a verdade dos números (não a suposição)

Antes de entregar o sistema, preciso corrigir a premissa. **O colégio não tem um problema de inadimplência hoje.** Os dados do Arca em 27/07/2026 mostram o contrário:

| Indicador (competência julho/2026) | Valor real |
|---|---|
| Mensalidades pagas | 23 de 24 (95,8%) |
| Pagas **pontualmente** | 22 de 24 (91,7%) — R$ 33.237,00 |
| Pagas com atraso | 1 — R$ 1.647,00 |
| Vencidas em aberto | 1 — R$ 188,17 |
| Cobranças avulsas vencidas | 2 — R$ 250,50 |
| **Total realmente vencido hoje** | **~R$ 438,67 (≈ 0,5% do faturado)** |

Inadimplência de 0,5% está **dez vezes abaixo** do limite de 5% que caracteriza ausência de processo. A base é saudável: 20 alunos ativos, ticket médio de R$ 1.297, faturamento recorrente de ~R$ 25 mil/mês, e 41 de 41 responsáveis com CPF cadastrado.

**Então por que este sistema é necessário?** Por dois motivos concretos:

**1. Existe UM caso estrutural que precisa de ação agora.** O responsável **Jairo Dimas Bonfim** acumula **R$ 2.332,17 em 4 títulos, com 22 dias de atraso**. Isso não é ruído: é o padrão clássico de bola de neve — títulos que se acumulam viram os casos de 90+ dias que quase nunca se recuperam. Um caso hoje, mas é *o* caso.

**2. A inadimplência está baixa por boa vontade e escala pequena, não por sistema.** A cobrança hoje é manual e reativa. Com 20 alunos e famílias engajadas, isso funciona. Quando a escola crescer — e o Salomão já automatiza o atendimento — a ausência de processo aparece. A hora de instalar o processo é agora, com a casa em ordem, não depois da crise.

A boa notícia: **a infraestrutura já existe** (Salomão no WhatsApp, disparo de boletos, PagBank em homologação, CRM com régua). Falta a *camada de processo* por cima. É isso que este documento entrega.

### A trava que a maioria dos modelos de cobrança ignora

Escola não cobra como loja. A **Lei das Anuidades (Lei nº 9.870/1999)** e o **CDC** impõem limites que precisam estar no sangue do processo:

- **Proibido penalizar pedagogicamente** por dívida durante o ano letivo contratado: não reter histórico/documentos, não suspender de provas ou atividades, não expor a criança. Isso é ilegal e gera dano moral.
- **Multa moratória máxima de 2%** sobre o valor + **juros de até 1% ao mês**. Nada além disso.
- **Cobrança sem constrangimento** (CDC art. 42): nada de expor a família a ridículo, ameaça ou cobrança vexatória.
- **Dado do menor é protegido** (LGPD/ECA): a cobrança fala com o **responsável financeiro**, e o Salomão já trava a informação individual atrás do 2º fator (3 dígitos do CPF).
- **O que a escola PODE:** cobrar por todos os meios civis (WhatsApp, e-mail, ligação, protesto, negativação se o contrato prevê) e **não renovar a matrícula** para o ano seguinte quando há débito, com aviso prévio (art. 5º).

Toda a régua abaixo respeita essas travas.

---

## 1. Política de crédito (prevenção)

O princípio: *política de crédito evita o problema antes; régua resolve depois — os dois são necessários.* Na escola, o "crédito" aparece em três momentos: a **matrícula** (mensalidade recorrente), a **rematrícula** e as **cobranças avulsas** (colônia, material, atividades extras — hoje parceláveis em até 12x no sistema).

### 1.1 Regra de ouro da matrícula (já quase pronta no Arca)

No ato da matrícula, todo aluno precisa ter:

1. **Um responsável financeiro único e identificado**, com **CPF e WhatsApp validados** — vocês já têm 41/41 com CPF. O único ajuste: **validar o número de WhatsApp no cadastro** (confirme enviando uma mensagem-teste), porque o gargalo do 9º dígito já causou falha de identificação no Salomão.
2. **Contrato de prestação de serviços assinado**, com vencimento fixo (dia 5), valor, reajuste e a cláusula de meios de cobrança e não-renovação por inadimplência.
3. **Meio de pagamento recorrente definido** — boleto/PIX automático (disparo mensal via Salomão). Débito recorrente reduz esquecimento, que é a maior causa de atraso nesta faixa.

### 1.2 Classificação por histórico — o semáforo

Use o próprio dado de pagamento do Arca para classificar cada família. É a régua que define quanto "crédito" (parcelamento de extras) cada uma recebe:

| Perfil | Critério (histórico interno) | Crédito para extras/colônia | Mensalidade |
|---|---|---|---|
| 🟢 **Verde — adimplente** | Sem atrasos nos últimos 6 meses | Parcelar em até 6–12x (PagBank) | Recorrente normal |
| 🟡 **Amarelo — atenção** | 1–2 atrasos leves (até 15 dias) | Parcelar em até 3x; sem novo parcelamento se houver título aberto | Recorrente + lembrete D-3 reforçado |
| 🔴 **Vermelho — risco** | Atraso recorrente, 30+ dias, ou acordo quebrado | Extras **só à vista ou 2x**; nenhum novo parcelamento com título em aberto | PIX antecipado / débito recorrente obrigatório |

Regra dura: **nenhuma família com título vencido recebe parcelamento de um novo extra.** Primeiro regulariza, depois parcela. Isso sozinho evita o acúmulo que criou o caso Jairo.

### 1.3 Famílias que já atrasaram antes

- Entram automaticamente em 🟡 ou 🔴 conforme a gravidade.
- Colônia/material do período seguinte: só liberado após quitar o pendente.
- Se houver acordo em andamento, o extra fica bloqueado até o acordo ser cumprido.
- A classificação é **reversível**: 6 meses de pontualidade devolvem a família ao 🟢. A cobrança é sobre o comportamento, nunca sobre a pessoa.

---

## 2. Régua de cobrança completa

Uma régua é uma sequência **determinística** de contatos: o sistema decide *quando* (dia do atraso), o Salomão decide *como dizer*, a secretaria entra *quando precisa de humano*. Mesma lógica que a Sara já usa nos leads — aqui aplicada à cobrança.

| Momento | Canal | Quem | Tom | Ação no sistema |
|---|---|---|---|---|
| **D-3** (lembrete preventivo) | WhatsApp | Salomão | Leve, gentil | Lembrete "vence em 3 dias" + linha do PIX/boleto |
| **D0** (vencimento) | WhatsApp | Salomão | Leve | "Vence hoje" + 2ª via na hora |
| **D+3** | WhatsApp | Salomão | Amigável | 1º aviso de atraso + oferta de PIX imediato |
| **D+7** | WhatsApp | Salomão | Amigável-firme | 2º aviso + 2ª via + convite a resolver hoje |
| **D+15** | WhatsApp + ligação | Secretaria (humano) | Parceiro, acolhedor | Contato humano, entender a situação, oferecer negociação |
| **D+30** | Ligação + WhatsApp/e-mail | Secretaria | Firme, respeitoso | Proposta formal de acordo (à vista com perdão de multa/juros, ou parcelar o atraso) |
| **D+60** | E-mail formal + WhatsApp | Direção/Secretaria | Formal, direto | Formalizar acordo por escrito; aviso sobre impacto na renovação |
| **D+90+** | E-mail/carta + protesto/negativação (se contrato prevê) | Direção | Formal | Última régua interna; aviso de não-renovação para o ano seguinte. **Nunca** medida contra a criança |

**Encargos:** a partir de D+1, os títulos vencidos podem receber **multa de 2% + juros de 1% ao mês** (o teto legal). Configure no boleto/PagBank — nunca acima disso.

**Reengajamento:** se a família responde ou paga em qualquer ponto, a régua zera para aquele título (igual ao follow-up da Sara). Pagou o de julho mas o de agosto vence — cada título tem sua régua.

**Automação real:** D-3 a D+7 são 100% Salomão (WhatsApp automático). D+15 em diante entra o humano — o Salomão registra um **recado para a secretaria** (`atendimento_recados`) e pausa, exatamente como já faz no transbordo.

---

## 3. Scripts prontos por canal

Na voz da casa — a mesma do Salomão: acolhedora, "família/mamãe/papai", emojis com moderação (💛😊). **Regra de LGPD:** os textos falam com o responsável financeiro e citam apenas "a mensalidade de [mês]"/"o boleto" — nunca dados da criança. O detalhe individual (valores por aluno) só é revelado pelo Salomão *depois* da confirmação dos 3 dígitos do CPF.

### D-3 — Lembrete preventivo (WhatsApp)
> Oi, [Nome]! 😊 Passando só para lembrar com carinho: a mensalidade de agosto vence no dia 05.
>
> Se quiser já deixar resolvido, posso te enviar a linha do PIX agora. É só me chamar! 💛

### D0 — Vencimento (WhatsApp)
> Oi, [Nome]! Hoje é o vencimento da mensalidade de agosto 💛
>
> Se precisar da 2ª via ou do PIX na hora, me avise que eu envio agora mesmo.

### D+3 — 1º aviso de atraso (WhatsApp)
> Oi, [Nome], tudo bem? 😊 Notei que a mensalidade de agosto ainda consta em aberto por aqui.
>
> Pode ser só um esquecimento — acontece! Quer que eu te reenvie o boleto ou a linha do PIX para facilitar?

### D+7 — 2º aviso (WhatsApp)
> Oi, [Nome]! Voltando aqui sobre a mensalidade de agosto, que segue em aberto 💛
>
> Consigo te enviar o PIX para pagamento imediato, ou, se estiver num momento mais apertado, posso deixar um recado para a secretaria conversar com você sobre as opções. O que fica melhor?

### D+15 — Contato humano / negociação (WhatsApp da secretaria)
> Oi, [Nome], aqui é a [Secretaria] do Pequenos Guardiões 💛
>
> Estou passando pessoalmente porque a mensalidade de agosto está em aberto e a gente prefere resolver junto, com tranquilidade. Aconteceu alguma coisa? Me conta que a gente encontra o melhor caminho — dá para facilitar o pagamento à vista ou dividir o valor em atraso. Quando você tem uns minutinhos para conversar?

### D+30 — Proposta formal de acordo (e-mail + WhatsApp)
> **Assunto:** Regularização — mensalidade em aberto | Colégio Pequenos Guardiões
>
> Prezado(a) [Nome],
>
> Identificamos que a mensalidade de [mês] permanece em aberto. Queremos ajudar você a regularizar da forma mais leve possível e temos duas opções:
>
> 1. **À vista até [data]:** pagamento sem a multa e os juros de atraso — só o valor original.
> 2. **Parcelado:** dividimos o valor em atraso em até 3x pelo PagBank, para caber no seu orçamento.
>
> Basta responder este e-mail ou nos chamar no WhatsApp [número] que preparamos tudo. Estamos à disposição.
>
> Atenciosamente, Secretaria — Colégio Pequenos Guardiões

### D+60 — Formalização (e-mail formal)
> **Assunto:** Notificação de débito e proposta de acordo | Colégio Pequenos Guardiões
>
> Prezado(a) [Nome],
>
> Consta em nossos registros débito referente a [descrição/competência], vencido em [data], no valor atualizado de R$ [valor] (principal + multa de 2% + juros de 1% a.m.).
>
> Reforçamos nossa disposição em negociar (à vista com desconto dos encargos ou parcelamento). Solicitamos seu retorno em até 7 dias para formalizarmos um acordo. Permanecendo o débito, ele poderá impactar a renovação da matrícula para o próximo ano letivo, conforme o contrato firmado.
>
> Seguimos abertos ao diálogo. Atenciosamente, Direção — Colégio Pequenos Guardiões

*(D+60 e além são sempre humanos e formais; o Salomão não conduz esta etapa.)*

---

## 4. Processo de negociação — quando a família quer, mas não pode pagar

A maior parte da recuperação vem daqui, não da pressão. O roteiro em quatro passos:

### 4.1 Ouvir e diagnosticar
Antes de propor qualquer coisa, entenda a causa. Uma pergunta aberta resolve: *"Me conta o que aconteceu para a gente encontrar o melhor caminho."* Classifique:
- **Esquecimento** → resolve na hora com PIX/2ª via. Não é negociação.
- **Dificuldade temporária** (mais comum) → oferecer prazo/parcelamento.
- **Insatisfação** (reclamação disfarçada de atraso) → transbordo para a coordenação; resolver a insatisfação *antes* de cobrar.

### 4.2 O que oferecer — em cascata, nunca tudo de uma vez
1. **PIX à vista com perdão de multa e juros** (paga hoje só o valor original). É o desconto de maior recuperação e o único juridicamente seguro.
2. **Parcelamento do atraso** em 2–3x via PagBank.
3. **Prazo extra** até uma data combinada (para quem tem data certa de entrada de recurso).

**Trava importante:** o desconto é sempre sobre **multa/juros ou pontualidade** — **nunca sobre o valor principal da mensalidade.** Descontar o principal quebra a isonomia entre as famílias e cria precedente perigoso (além de tensionar a Lei das Anuidades). "Perdoo os encargos se pagar hoje" é generoso e correto; "dou 30% na mensalidade" não.

### 4.3 Formalizar o acordo
- Todo acordo vira **registro escrito**: para valores menores, a confirmação por WhatsApp já serve como prova (print no `atendimento_recados`/anotação do CRM). Para valores altos ou parcelamento longo, **termo de acordo assinado**.
- Registre no Arca/CRM: quem, quanto, em quantas parcelas, vencimentos. O acordo passa a ser o novo título a acompanhar.

### 4.4 Se o acordo não for cumprido
- **Não recomece do zero.** Retome a régua do ponto onde o acordo quebrou (não volte ao D+3 gentil de quem nunca foi avisado).
- Primeiro descumprimento: contato humano firme, reforçando o combinado.
- **Dois acordos quebrados** → encerra a fase amigável: protesto/negativação (se o contrato prevê) e **aviso formal de não-renovação** para o ano seguinte. Sempre respeitando: nada de medida contra a criança durante o ano letivo.

---

## 5. Mapa de recuperação dos inadimplentes atuais

Como a inadimplência real hoje é baixa e concentrada, a priorização é simples — e é por isso que dá para resolver **tudo em 30 dias**.

### 5.1 Priorização (matriz valor × tempo × recuperabilidade)

| Prioridade | Caso | Em aberto | Atraso | Ação |
|---|---|---|---|---|
| 🔴 **1 — Crítico** | **Jairo Dimas Bonfim** | R$ 2.332,17 (4 títulos) | 22 dias | Contato humano imediato + acordo. É 84% de toda a inadimplência vencida da escola |
| 🟡 **2 — Varredura** | Avulsas vencidas (2 títulos) | R$ 250,50 | até 30 dias | Salomão: PIX na hora, 1 toque |
| 🟢 **3 — Residual** | Mensalidade vencida (R$ 188,17) + ajuste R$ 2,00 (Erica) | R$ 190,17 | ~26 dias | Salomão automático; provavelmente proporcional/esquecimento |

**O ponto que salta:** um único responsável (Jairo) concentra ~84% da inadimplência vencida. Resolver esse caso é resolver a inadimplência da escola. Toda a energia da Semana 1 vai para ele.

### 5.2 Plano de ação — próximos 30 dias

**Semana 1 — Estancar e varrer**
- **Caso Jairo:** ligação da secretaria (tom parceiro), entender a situação, aplicar a cascata de negociação (à vista sem encargos → parcelar em 3x). Formalizar por escrito. *Meta: acordo fechado em 5 dias úteis.*
- **Varredura dos residuais:** disparar os avisos do Salomão (D+3/D+7) para os ~R$ 440 restantes. A maioria paga com um lembrete.

**Semana 2 — Ligar o preventivo para agosto**
- Ativar a régua **D-3 e D0** para as 17 mensalidades de agosto (vencem 05/08, R$ 25.902). Isto é o que protege o mês que vem *antes* de virar atraso — o maior retorno da operação.
- Configurar multa/juros (2% + 1% a.m.) no boleto/PagBank.

**Semana 3 — Instalar a prevenção**
- Aplicar a **política de crédito** (semáforo) nas próximas matrículas e em qualquer novo parcelamento de extra.
- Validar WhatsApp no cadastro dos responsáveis (fecha o gargalo do 9º dígito que já quebrou a identificação do Salomão).

**Semana 4 — Medir e institucionalizar**
- Montar o painel de indicadores (abaixo) no CRM.
- Rodar a primeira leitura mensal e definir a meta do próximo ciclo.

### 5.3 Indicadores para acompanhar (instrumentar no CRM/Arca)

| KPI | Como medir | Meta inicial |
|---|---|---|
| **% de pontualidade** | Pagos até o vencimento ÷ total do mês | ≥ 90% (já está em 91,7%) |
| **Inadimplência 30/60/90** | Vencido não pago por faixa ÷ faturado | < 3% em 30d; ~0% em 90d |
| **Prazo médio de recebimento (DSO)** | Média de dias entre vencimento e pagamento | Reduzir mês a mês |
| **Taxa de recuperação** | Recuperado ÷ entrado em atraso | ≥ 80% |
| **% em débito automático/recorrente** | Alunos com PIX/boleto recorrente | Crescente |

---

## Onde isto encaixa nas suas ferramentas (e o que falta)

- **Salomão (WhatsApp/Evolution):** já entrega boleto, responde financeiro com trava de CPF e registra recado. Assume a régua D-3 a D+7. *Falta:* criar os gatilhos por dia de atraso (mesmo motor da régua da Sara).
- **Disparo de boletos (Arca):** já funciona. É o D-3/D0 mensal. Agora aparece no chat do CRM (corrigido hoje).
- **PagBank (homologação pendente):** ao aprovar, libera a **Fase 2** — 2ª via de PIX na hora pelo Salomão, fechando cobrança→pagamento sem humano. É a peça que multiplica a recuperação em D+3/D+7.
- **CRM (kanban + régua):** o motor de follow-up da Sara serve para a régua de cobrança — reaproveitar, não reconstruir.
- **Secretaria (humano):** entra do D+15 em diante, via recado do Salomão.

**Próximo passo que eu recomendo:** o caso Jairo não espera o sistema — é uma ligação humana esta semana. Em paralelo, a maior alavanca de engenharia é ligar os gatilhos da régua no Salomão (D-3 a D+7) antes do vencimento de agosto em 05/08. Se quiser, eu especifico esses gatilhos no mesmo formato do follow-up da Sara e já deixo pronto para implementar.

---

*Todos os números vêm do banco Arca (SGEI) em 27/07/2026. Orientações jurídicas são gerais (Lei 9.870/1999, CDC, ECA/LGPD) e não substituem parecer do jurídico da escola antes de medidas como protesto, negativação ou não-renovação.*
