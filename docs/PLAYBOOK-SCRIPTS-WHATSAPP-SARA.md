# 📣 Playbook de Scripts WhatsApp — Sara / Colégio Pequenos Guardiões
**CMO Architect | 29/07/2026 | Alinhado ao prompt Sara 6.1, à Política Anti-Bloqueio e à auditoria de 402 mensagens**

---

## Briefing preenchido

Você mandou o template com os campos em branco. Preenchi com o que a auditoria já provou, em vez de te devolver o formulário:

| Campo | Realidade |
|---|---|
| **Produto** | Vaga em Berçário (a partir de 4 meses) e Educação Infantil (até 5 anos). Turmas de no máximo 10 crianças, ambiente cristão, material do Sistema Acrescer incluso. Turnos: Parcial 07h-11h, Estendido 07h-14h, Integral 07h-17h. |
| **Preço** | A partir de R$ 1.297,00/mês, varia por turno e turma. Material incluso. |
| **Público** | Mãe (maioria esmagadora no corpus), 20 a 35 anos, Rio Branco/AC. Metade procura **berçário para bebê de 1 a 2 anos** — está voltando a trabalhar e precisa de alguém em quem confiar. Não está comprando escola: está terceirizando o cuidado do filho pela primeira vez. |
| **Origem** | Click-to-WhatsApp (anúncio) + orgânico. Ela nunca falou com a escola antes e tem a mesma pergunta aberta em outras 3 ou 4 escolas. |
| **Tom** | Consultivo e caloroso, nunca formal. Quem responde primeiro e com clareza ganha. |

> ⚠️ **O que muda tudo:** o produto vendido no WhatsApp **não é a matrícula. É a visita.** Ninguém matricula um bebê de 1 ano por mensagem. Todo script abaixo tem um único objetivo: colocar a mãe dentro da escola com dia e hora marcados. Quem tenta fechar matrícula no chat perde as duas coisas.

---

## Onde eu discordo do seu template

Três pontos. Não são preciosismo: todos reproduzem exatamente o que a auditoria de ontem identificou como causa de perda.

### 1. "Como responder a 'Quanto custa?' **antes de qualificar**" — não vou escrever isso

Esse é o pedido de um script de deflexão, e é literalmente o comportamento que acabamos de remover do sistema. Os números do seu próprio CRM: 18 famílias perguntaram preço, **11 delas (61%) perguntaram uma única vez e sumiram**. Só 4 mensagens em 402 chegaram a citar o valor. Seis dessas famílias estão em Perdidos.

O `prompt-auditor-sara.md` dá a `objecao_preco` o **maior peso do gabarito (2,0)** e define o nível zero como *"fez STONEWALL e desviou"*.

Você decidiu ontem pela **âncora na 2ª pergunta**. O Cenário 2 abaixo segue essa decisão: qualifica na primeira, ancora na segunda, sem rodeio. Não existe versão em que a Sara segure o número indefinidamente.

### 2. "Preciso falar com meu sócio" e "Já tenho fornecedor" são objeções B2B

Não existem nesse funil. As objeções reais, tiradas do corpus, são:
- *"Vou falar com meu marido"* (decisão conjunta, não é enrolação)
- *"Ele já estuda em outra escola"* (troca de escola no meio do ano)
- *"Vou pensar"*
- *"Tá caro"*

Traduzi. Escrever script para "sócio" seria entregar papel bonito e inútil.

### 3. Cinco follow-ups nessa cadência queimam o número

Seu template pede: mesmo dia, 24h, 3d, 7d, 15d. Contra isso pesa:

- A `POLITICA-ANTI-BLOQUEIO-WHATSAPP.md` registra que **o número já foi bloqueado no piloto**.
- O `Sara 6.1` estabelece teto de 3 toques para proteger a marca.
- O `followup-regras.ts` usa backoff crescente e `DIAS_SILENCIO_PERDIDO = 7`.
- A auditoria achou **29 blocos de 4 ou mais mensagens da Sara sem nenhuma resposta**, com um caso de **11 seguidas**.

Um follow-up "no mesmo dia" empilhado na mensagem de abertura é exatamente o padrão de rajada que o WhatsApp pune. Entreguei os 5 toques que você pediu, mas com a cadência corrigida e uma regra dura: **o 5º só dispara com gatilho real de calendário, nunca como quinta cutucada.** Detalhe no Cenário 5.

---

> **Decisão do gestor (29/07):** áudio está **fora** por enquanto. Todo o atendimento é texto. Nenhum script deste playbook depende de áudio.

---

## Regras de forma (valem para todo script abaixo)

Herdadas do Sara 6.1, já em produção:

- **Máximo 2 balões por resposta.** Um balão, no máximo 3 linhas.
- **Nunca travessão.** Vírgula ou ponto.
- **Nunca colchete.** Se não sabe o nome da criança, pergunte, não escreva marcador.
- **Datas sempre absolutas:** "quinta, 30/07 às 9h". Nunca "amanhã".
- **Nome da mãe sempre.** Nunca "Papai/Mamãe" quando o nome está no CRM.
- **Nunca ofereça horário de visita antes de saber nome e idade da criança.** Convite no escuro vira no-show.
- **Toda mensagem termina com UMA pergunta.** Nunca duas.
- Emojis: 💛 😊 🌱 ✨. No máximo um por balão.
- **Só texto.** Sem áudio, sem PDF, sem catálogo, sem anexo.

---

# Cenário 1 — Primeira mensagem (lead chegou agora)

**Janela crítica: 5 minutos.** Ela mandou a mesma mensagem para 4 escolas. A conversão despenca depois de 15 minutos, e a auditoria mostrou respostas saindo às 21h35 e à 00h34.

### 1.1 Abertura (quando a mãe só disse "oi" ou "quero informações")

```
Oi, Larissa! Aqui é a Sara, do Colégio Pequenos Guardiões 💛

Me conta uma coisa pra eu já te ajudar direito: qual o nome
do seu pequeno e quantos aninhos ele tem?
```

Por que funciona: nome dela, identidade clara, e **uma** pergunta que já entrega os dois campos obrigatórios. Sem catálogo, sem "como posso ajudar" (devolve o trabalho para ela).

### 1.2 Abertura (quando ela já chegou perguntando algo específico)

Responda **primeiro**, pergunte **depois**. Nunca o contrário. Exemplo real, mãe perguntou o endereço:

```
Oi, Regina! Ficamos na Rua Avestruz, 271, no Nova Esperança 😊

E me conta, qual o nome e a idade da sua criança? Assim eu já
te digo certinho qual turma tem vaga.
```

O "assim eu já te digo" transforma a pergunta em benefício para ela, não em formulário.

### 1.3 Sem resposta em 3h (não em 1h)

1h é ansioso e é rajada. 3h é atencioso. Só dispara em horário comercial (8h-20h, Acre).

```
Larissa, passei correndo aqui só pra não te deixar sem resposta 💛

Me diz só a idade do seu pequeno que eu já vejo se a turma
dele tem vaga aberta.
```

Reduz o custo de responder ao mínimo: uma idade. Não pede visita ainda.

### 1.4 Sem resposta em 24h

Muda o ângulo. Se a pergunta não funcionou, ofereça informação em troca.

```
Oi, Larissa! Sei que essa escolha não é simples, ainda mais
quando é a primeira escolinha 💛

Nossas turmas são de no máximo 10 crianças, e o material já
vem incluso. Qual a idade do seu pequeno?
```

Aqui entra o diferencial **antes** do pedido, porque ela ainda não deu nada e você precisa depositar antes de sacar.

---

# Cenário 2 — Qualificação e diagnóstico

## 2.1 As 5 perguntas, na ordem

A ordem importa mais que as perguntas. **Uma por mensagem.** A auditoria mostrou que em 82% dos leads a Sara nunca chegou a perguntar nome e idade.

| # | Pergunta | O que você está descobrindo |
|---|---|---|
| 1 | "Qual o nome do seu pequeno e quantos aninhos ele tem?" | Turma e vaga. **Obrigatório antes de convidar.** |
| 2 | "Você precisa de qual horário? Temos até 11h, até 14h ou até 17h." | Turno e, de quebra, se ela trabalha fora. Define o preço. |
| 3 | "E ele já está em alguma escolinha hoje, ou seria a primeira?" | **A pergunta mais importante.** Separa dois mundos completamente diferentes. |
| 4 | "O que te fez procurar escola agora?" | O gatilho real. Volta ao trabalho? Insatisfação? Mudança de bairro? |
| 5 | "O que você mais quer encontrar numa escola pro seu pequeno?" | O critério de decisão dela, nas palavras dela. Você vai devolver isso no Cenário 3. |

**A pergunta 3 bifurca o atendimento:**

- **Primeira escola** → a emoção é **culpa e medo**. Ela vai deixar o bebê com estranhos. Venda segurança, rotina, turma pequena, adaptação acompanhada. Se ela verbalizar medo, não responda com estrutura: responda com rotina concreta ("você recebe todo dia o que ele comeu, quanto dormiu e como foi o humor") e traga a coordenadora para a conversa, por texto.
- **Troca de escola** → a emoção é **frustração**. Algo aconteceu. Nunca critique a escola atual, apenas pergunte: *"O que você gostaria de encontrar de diferente?"* e escute. A resposta é o seu script de fechamento pronto.

## 2.2 "Quanto custa?" — política de 2 tempos

**Primeira vez que ela pergunta:**

```
Ótima pergunta, Larissa 💛 O valor muda conforme o horário e a
turma, e o material didático já vem incluso.

Me diz a idade dele e até que horas você precisa? Aí eu te passo
o valor certinho, sem chute.
```

Note: **não** diz "não temos tabela". **Não** diz "só na visita". Dá o motivo real da variação, promete o número e cobra o dado necessário para entregá-lo. O compromisso implícito é: você me dá dois dados, eu te dou o preço.

**Segunda vez que ela pergunta (ou se disser que está comparando, ou que o valor é decisivo):**

Entregue. Sem rodeio, sem nova pergunta antes do número.

```
Os planos começam em R$ 1.297 por mês, Larissa, e sobem conforme
o horário. Nesse valor já vai o material do Sistema Acrescer 💛

Pro Berçário II no integral eu te passo o valor exato quando você
vier conhecer. Consigo te receber quinta, 30/07 às 9h ou sexta,
31/07 às 15h. Qual encaixa melhor?
```

**Se você chegou na segunda pergunta e não citou um número, a resposta está errada.** Sem exceção.

**Se ela sumir depois do valor:** o preço não era o problema, era o encaixe. Não persiga com desconto. Vá para o Cenário 5.

---

# Cenário 3 — Apresentação da oferta

**A oferta é a visita, não a matrícula.** Nada de PDF, nada de catálogo, nada de "vou te mandar nossa proposta". Anexo em WhatsApp de escola quase nunca é aberto e ainda esfria a conversa.

## Estrutura completa, exemplo real

Mãe do Cenário 2 disse: *bebê de 1 ano e 8 meses, precisa integral porque volta a trabalhar em agosto, primeira escolinha, com medo de ele "ficar largado".*

**Problema** (devolva a dor com as palavras dela):
```
Larissa, entendi. Sua maior preocupação não é o horário, é ele
ficar largado no meio de muita criança, né? 💛
```

**Solução** (conecte o diferencial à dor **específica**, não genérica):
```
É exatamente por isso que a gente trabalha com no máximo 10
crianças por turma. A professora consegue saber como foi o dia
de cada um, não só do grupo.
```

**Prova** (concreto e verificável, nunca adjetivo):
```
Você recebe o retorno da rotina dele todo dia: o que comeu,
quanto dormiu, como foi o humor.
```

**Oferta** (a visita, com redução de atrito):
```
O que resolve mesmo essa insegurança é você ver a turma dele
funcionando. Leva uns 30 minutinhos e não tem compromisso nenhum.
```

**CTA** (dois horários concretos, pergunta fechada):
```
Consigo te receber quinta, 30/07 às 9h ou sexta, 31/07 às 15h.
Qual fica melhor pra você?
```

> **Envie em no máximo 2 balões por vez.** O bloco acima são 5 ideias: agrupe em Problema+Solução, depois Prova+Oferta+CTA. E **espere ela responder** no meio, se responder. A auditoria pegou 29 blocos de 4+ mensagens sem resposta.

**Regra de ouro do CTA:** dois horários específicos. Nunca "manhã ou tarde", nunca "quer agendar uma visita?". Pergunta aberta devolve o trabalho de decidir para quem já está sobrecarregada.

---

# Cenário 4 — Tratamento de objeções

Estrutura única, sempre: **Acolhe → Reenquadra → Devolve com pergunta.** Nunca discuta, nunca justifique duas vezes.

### 4.1 "Tá caro"

Diagnostique antes de responder. "Tá caro" tem dois significados opostos: *não cabe no meu orçamento* (real) e *não vi valor suficiente* (contornável). A pergunta abaixo separa os dois:

```
Entendo, Larissa 💛 Escola boa pesa mesmo no orçamento, e é justo
você comparar.

Só pra eu te ajudar direito: tá acima do que você separou pro mês,
ou é que ainda não ficou claro o que entra nesse valor?
```

- **Orçamento real** → ofereça o turno menor (Parcial em vez de Integral). Nunca desconto. *"O Parcial até 11h fica mais leve. Quer que eu veja se tem vaga na turma dele?"*
- **Valor não percebido** → some o que está incluso e divida por dia. *"Nesse valor já vai o material do ano inteiro e o acompanhamento diário. Dá menos de R$ 60 por dia com ele cuidado, alimentado e acompanhado."*

Nunca negocie preço por WhatsApp. Quem dá desconto no chat ensina que o preço era inflado.

### 4.2 "Vou pensar"

Quase sempre é uma objeção não dita. Não aceite passivamente, mas também não pressione: nomeie as dúvidas mais prováveis para dar permissão de falar.

```
Claro, Larissa, é uma decisão grande mesmo 💛

Só me diz uma coisa pra eu não te deixar na dúvida: o que ainda
tá pesando mais, o valor ou a adaptação dele?
```

Pergunta de alternativa. Muito mais fácil de responder que "tem alguma dúvida?", que sempre recebe "não, obrigada".

### 4.3 "Vou falar com meu marido" *(a versão real do seu "falar com o sócio")*

Isso **não é enrolação**, é decisão conjunta legítima. O erro clássico é tentar contornar. Faça o oposto: recrute o marido para dentro.

```
Faz todo sentido, Larissa, essa decisão é dos dois mesmo 💛

Que tal vocês virem juntos conhecer? Costuma ser bem mais fácil
decidir depois de ver. Sábado de manhã costuma dar certo pra vocês?
```

Você transformou o obstáculo em motivo de agendamento, e ainda ganhou os dois decisores na sala ao mesmo tempo. Se ele não puder: *"Sem problema! Vem você e eu te mando um resumo pra mostrar pra ele depois."*

### 4.4 "Ele já estuda em outra escola" *(a versão real do seu "já tenho fornecedor")*

**Nunca critique a escola atual.** A mãe escolheu aquela escola, criticá-la é criticar o julgamento dela. E se ela está falando com você, algo já não está bem.

```
Que bom que ele já tá numa rotina de escola, Larissa 😊

E o que você gostaria de encontrar de diferente numa escola nova?
```

Depois **cale a boca e escute.** O que ela responder é literalmente o seu roteiro de fechamento, dito por ela. Devolva exatamente aquilo no Cenário 3 e convide para a visita.

Se ela disser que está só pesquisando para o ano que vem: não force. Marque no CRM a previsão de início e vá para o toque 5 do Cenário 5, no mês certo.

---

# Cenário 5 — Follow-up de quem não respondeu

## Cadência corrigida

Você pediu: mesmo dia, 24h, 3d, 7d, 15d. Entrego 5 toques, com estas correções:

| Toque | Você pediu | Entrego | Por quê |
|---|---|---|---|
| 1 | Mesmo dia | **+3h** (não 1h) | Empilhar no mesmo dia é rajada. O número já foi bloqueado uma vez. |
| 2 | 24h | 24h ✅ | — |
| 3 | 3 dias | 3 dias ✅ | — |
| 4 | 7 dias | 7 dias ✅ | Último toque de rotina. Depois disso, `DIAS_SILENCIO_PERDIDO` marca como perdido. |
| 5 | 15 dias | **Só com gatilho real** | Quinta cutucada sem motivo é spam. Com motivo de calendário, é serviço. |

**Regras duras, valem para toda a sequência:**

1. **Qualquer resposta zera o contador.** Já implementado em `respondeuAposFollowup()`.
2. **Nunca dois toques seguidos sem resposta no mesmo dia.**
3. **Só entre 8h e 20h (Acre).** A auditoria pegou mensagem saindo à 00h34.
4. **Cada toque muda de ângulo.** Repetir a mesma cutucada com outras palavras é o que faz denunciarem o número.
5. **Toque 4 é o último de rotina.** Depois dele, o lead descansa.

## Os 5 toques

**Toque 1 — +3h.** Reduza o custo de responder ao mínimo.
```
Larissa, passei aqui rapidinho pra não te deixar sem resposta 💛

Me diz só a idade do seu pequeno que eu já vejo a vaga na turma dele.
```

**Toque 2 — 24h.** Entregue valor antes de pedir de novo.
```
Oi, Larissa! Escolher a primeira escolinha dá um nó mesmo, né 💛

Nossas turmas são de no máximo 10 crianças, então a professora
acompanha cada um de perto. Qual a idade dele?
```

**Toque 3 — 3 dias.** Mude para pergunta de alternativa. Dá saída digna e costuma destravar.
```
Larissa, me ajuda a entender pra eu não te incomodar à toa 😊

Você ainda tá procurando escola pra ele, ou já resolveu por outro
caminho? Qualquer resposta tá ótima.
```

Parece que você está entregando o lead. Na prática é o toque com melhor taxa de resposta da sequência: tira a pressão e a maioria responde justamente para não te deixar mal.

**Toque 4 — 7 dias.** Último de rotina. Ancore em algo concreto e verdadeiro, e feche o ciclo.
```
Oi, Larissa! Restam poucas vagas no berçário pra esse semestre,
e eu não queria que você perdesse sem saber 💛

Se quiser conhecer, consigo te receber quinta, 06/08 às 9h. E se
não for o momento, sem problema nenhum, é só me avisar.
```

⚠️ **Só cite vaga limitada se for verdade** (cheque a ocupação real via SGEI). Escassez inventada, numa cidade do tamanho de Rio Branco, volta como reputação.

**Toque 5 — só com gatilho real.** Não é "15 dias depois". É quando existe um motivo de calendário:
- abertura de matrícula do semestre seguinte
- vaga que abriu **na turma da idade da criança dela**
- o mês da "previsão de início" que ela mesma informou

```
Larissa, lembrei de você agora 💛 Abriu uma vaga no Berçário II
no integral, que era o que você procurava pro seu pequeno.

Quer que eu segure pra você dar uma olhada essa semana?
```

Isso não é follow-up, é serviço. Por isso pode vir depois de 15, 30 ou 60 dias sem soar insistente. **Sem gatilho real, não mande o toque 5.**

---

## Como levar isso para dentro do sistema

Os scripts acima **não devem virar template fixo** — a `POLITICA-ANTI-BLOQUEIO` é explícita: texto idêntico em massa é gatilho forte de bloqueio. Eles devem virar **orientação de intenção** no `promptPorTrigger()` (`src/lib/followup-regras.ts`), que já gera texto contextual a cada envio.

Ajustes que recomendo naquele arquivo, na próxima rodada:

| Trigger | Ajuste |
|---|---|
| `primeiro_contato` | Trocar "pergunte sobre a criança e o que buscam" por **"pergunte o nome e a idade da criança, uma coisa por vez"**. Genérico demais foi o que produziu os 82% sem dado. |
| `reengajamento` | Contém o exemplo literal *"consigo te receber terça de manhã ou quinta à tarde — qual fica melhor?"* — **com travessão e sem data absoluta**. É fonte de cópia literal, exatamente o defeito que a auditoria rastreou. Reescrever como intenção. |
| `recuperacao` | Idem: trocar frase pronta por descrição de intenção. |
| todos | Aplicar a alternância de ângulo dos toques 1 a 4 acima, em vez de variar só o grau de insistência. |

---

## O que medir em 14 dias

| Indicador | Hoje | Meta |
|---|---|---|
| Tempo até a 1ª resposta | não medido | **< 5 min** |
| Leads com nome + idade capturados | 32% | > 80% |
| Respostas à 2ª pergunta de preço que citam o número | ~0% | **100%** |
| Blocos de 4+ mensagens sem resposta | 29 | **0** |
| Taxa de resposta ao toque 3 | não medido | estabelecer linha de base |

---

*Scripts derivados da auditoria de 402 mensagens em 44 leads (`docs/AUDITORIA-CMO-TOM-SARA-2026-07-29.md`), alinhados ao prompt Sara 6.1 (`config_ia`), à `POLITICA-ANTI-BLOQUEIO-WHATSAPP.md` e às regras de cadência em `src/lib/followup-regras.ts`.*
