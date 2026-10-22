# 📣 Auditoria de Tom e Condução — Sara 6.0
**CMO Architect | 29/07/2026 | Corpus: 402 mensagens da Sara, 44 leads, 31/01 a 28/07/2026**

---

## Veredito em uma linha

Você acertou o sintoma e errou o diagnóstico. O travessão é 8% do problema e não vem do modelo — vem do **seu próprio prompt**, que ensina a Sara a falar com travessão. A falha de captura é real e grave (82%), mas é **consequência**, não causa. E existe um terceiro problema, que você não citou, que está matando mais matrícula que os outros dois somados: **a Sara está proibida de falar preço por uma regra que contradiz o próprio prompt dela.**

Não recomendo mexer no tom antes de resolver o conflito de instruções. Ajustar tom agora é pintar parede com vazamento atrás.

---

## 1. O que os números dizem

### 1.1 Captura de dados obrigatórios — falha estrutural

| Métrica | Resultado |
|---|---|
| Leads com os 4 campos obrigatórios (nome, idade, série, período) | **8 de 46 — 17%** |
| Idem, só entre leads engajados (família respondeu 2+ vezes) | **7 de 31 — 23%** |
| Leads onde a Sara **nunca perguntou nome nem idade** da criança | **28 de 34 — 82%** |
| Mensagens no corpus inteiro perguntando o nome da criança | **5 de 402** |
| Mensagens perguntando a idade | **8 de 402** |

Casos que provam que não é falta de conversa:

| Família | Msgs da família | Msgs da Sara | Dados capturados | Destino |
|---|---|---|---|---|
| Ana Paula Almeida | 4 | 17 | nenhum | Em Atendimento (morto) |
| Regina Silva | 8 | 17 | nenhum | **Perdidos** |
| Vitória Milena | 5 | 16 | nenhum | Em Atendimento |
| Suellem | 7 | 15 | nenhum | **Perdidos** |
| Nathacha Souza | 14 | 8 | nenhum | — |
| Danielly Macedo | 14 | 10 | nenhum | — |

17 mensagens trocadas com Ana Paula sem descobrir o nome da criança. Isso não é timidez de coleta, é ausência de coleta.

**Contaminação adicional:** onde capturou, capturou lixo — `crianca.nome` = `"A confirmar"` (3 leads), `"..."` (1 lead). A Sara está gravando placeholder como se fosse dado. Isso é pior que campo vazio, porque um campo vazio o gestor vê; `"A confirmar"` passa por preenchido.

### 1.2 Tom e forma

| Métrica | Resultado | Leitura |
|---|---|---|
| Mensagens com travessão (— ou –) | 31 / 402 = **7,7%** (8,2% em julho) | Real, mas concentrado |
| Placeholder de template vazado para a família | **4** | Grave |
| "Papai/Mamãe" com o nome da mãe já conhecido | **5** | Grave |
| Mensagens que terminam sem pergunta | **65,4%** | Viola a "Regra de Ouro" do próprio prompt |
| Encerramentos frouxos ("estou à disposição", "qualquer dúvida") | **65** | Explicitamente proibidos no prompt |
| Mensagens duplicadas literalmente | **11** (7 delas em < 5 min) | Bug, não estilo |
| Razão Sara : família | **1,4 : 1** (chega a 4,2:1) | Monólogo |
| Blocos de 4+ mensagens da Sara sem resposta da família | **29** (máx.: 11 seguidas) | Risco de bloqueio no WhatsApp |
| Uso de data relativa ("hoje", "amanhã") com a família | **34** | Quebra em follow-up |

### 1.3 A evidência mais cara do corpus

**Ana Paula Almeida, 13/07 21:35** — família pergunta o valor duas vezes:

> **Sara:** "Papai/Mamãe, como nós trabalhamos com turmas bem reduzidas […] nós não temos uma tabelinha de preço única. 💛"
> **Sara:** "Papai/Mamãe, como nós trabalhamos com turmas bem reduzidas […] nós não temos uma tabelinha de preço única. 💛"  ← *duplicada*
> **Sara:** "Nós gostamos de entender primeiro o que você busca para o desenvolvimento do(a) **[nome da criança]**"  ← *placeholder vazado*
> **Família:** "no momento estou analisando apenas mensalidades"
> **Sara:** *(nunca deu o valor)*

Quatro falhas em uma tela: nome genérico com o nome conhecido, mensagem duplicada, placeholder cru, e stonewall de preço contra pedido explícito. O lead está parado desde então.

**Suellem, 30/06 19:20** — família diz "**Eu posso ir agora**. Qual endereço?":

> **Sara:** "Estamos localizados em um ponto de fácil acesso e com segurança"  ← *não respondeu*
> **Sara:** "Estamos na **Rua Principal, 123**"  ← *endereço inventado*

O endereço correto só chegou **dois dias depois**. Uma família pronta para ir à escola naquele minuto foi perdida. (O endereço hoje está hardcoded em `sara.ts` — provavelmente correção reativa a este caso. Mas ele é o **único** fato protegido assim.)

---

## 2. Causa-raiz — três conflitos de instrução

Nenhum dos três se resolve pedindo à Sara "seja mais natural".

### 🔴 Conflito 1 — a coleta perde para o agendamento, por escrito

O `config_ia.system_prompt` define:

- **"REGRA DE OURO (inegociável)"** → toda mensagem termina oferecendo dois horários de visita.
- **"Dados a obter […] de leve e uma pergunta por vez: nome da criança, idade, período"** → linha solta, sem status, com o advérbio **"de leve"**.

Uma regra é declarada *inegociável*; a outra é *de leve*. O modelo faz o que você mandou: pula a qualificação e corre para o agendamento. Os 82% de leads sem nome/idade são **o prompt funcionando como escrito** — não um desvio dele.

E a "Regra de Ouro" também falha por excesso: 65% das mensagens não terminam com pergunta e 65 terminam em "estou à disposição", justamente a frase que o prompt proíbe. Uma regra absoluta que é violada em 2 de cada 3 mensagens não está governando nada.

### 🔴 Conflito 2 — o preço tem duas fontes de verdade que se anulam

| Fonte | O que diz |
|---|---|
| `config_ia.system_prompt` (seção PREÇO) | "Nossos planos começam **a partir de R$1.297**" |
| `base_conhecimento` (categoria `precos`) | "Apresentamos os valores completos **durante a visita presencial**" — **sem nenhum número** |
| `src/lib/sara.ts` (linhas 246–255) | Injeta a KB sob "**USE APENAS ESTAS INFORMAÇÕES. NUNCA INVENTE DADOS NÃO LISTADOS**" + "NUNCA invente […] **valor** […] não listado", rotulado **"REGRA ANTI-ALUCINAÇÃO — CRÍTICA"** |

O bloco anti-alucinação é montado **depois** do prompt do `config_ia`, é rotulado *crítica*, e proíbe explicitamente citar valor não listado na KB. R$1.297 **não está na KB**. Resultado: o modelo obedece a regra mais recente e mais forte, suprime a âncora, e sobra só a desculpa — "não temos tabelinha única" (23 mensagens no corpus).

Isso importa muito mais do que parece. O seu próprio `docs/prompt-auditor-sara.md` classifica `objecao_preco` como **o critério mais discriminante** (peso 2,0, o maior de todos) e define exatamente este comportamento como o pior nível possível:

> *"Ausente: fez STONEWALL ('não temos tabela única / gostamos de entender primeiro') e desviou."*

Você já sabia que isso prevê perda. O sistema está produzindo isso 23 vezes por design, porque a KB manda.

### 🔴 Conflito 3 — o travessão é decoreba do script, não "voz de IA"

O prompt escreve os exemplos prontos, com travessão dentro:

> `"Ótima pergunta, papai/mamãe — faz total sentido querer entender o investimento antes de decidir 💛"`
> `"Consigo te receber quinta às 9h ou sexta às 15h — qual fica melhor?"`
> `"o melhor é você conhecer a escola e a gente encontrar junto o que funciona para o(a) [nome]"`

E o corpus devolve, literalmente:

> `"Ótima pergunta, Helen — faz total sentido querer entender o investimento antes de decidir 💛"`
> `"Consigo te receber quarta-feira, 29/07 às 07:30 ou às 08:30 — qual horário fica melhor?"`

O modelo está copiando a frase de exemplo caractere por caractere, travessão incluso — e, quando não sabe substituir, copia `[nome da criança]` e `papai/mamãe` também. **O travessão, o placeholder vazado e o "Papai/Mamãe" são o mesmo defeito**: exemplos literais escritos como se fossem falas prontas.

Por isso o travessão está em 8% e não em 50% — ele só aparece nas mensagens que caem nos scripts decorados (preço e convite de visita). Corrigir os exemplos resolve os três de uma vez.

---

## 3. Correções — em ordem de retorno

### P0 — Nesta semana (bloqueiam receita agora)

**1. Unificar a fonte de verdade do preço.**
Atualizar `base_conhecimento` (`precos`) para conter a âncora real:
> "Os planos começam a partir de R$ 1.297 e variam conforme o período (Parcial, Estendido, Integral) e a turma. O material didático já está incluso. O valor exato do plano da criança é fechado na visita."

Sem isso, a regra anti-alucinação continuará (corretamente) censurando o número. Não adianta mexer no `config_ia`.

**2. Promover a coleta ao mesmo status do agendamento.**
Trocar "de leve" por regra dura e **condicionar o convite de visita**: sem nome + idade, não oferece horário. Ver §4.

**3. Matar os exemplos literais.**
Todo exemplo do prompt vira instrução descritiva, sem aspas prontas, sem travessão, sem `[nome]`, sem "papai/mamãe". Ver §4.

**4. Corrigir a duplicação.**
11 mensagens duplicadas, 7 em menos de 5 min — cheira a webhook processando o mesmo evento duas vezes. Investigar idempotência em `src/app/api/webhook/whatsapp/route.ts`. É bug de código, não de prompt, e é o que mais faz a Sara parecer robô.

### P1 — Próximas duas semanas

**5. Teto de mensagens sem resposta.** 29 blocos de 4+ mensagens sem a família responder, um deles com 11 seguidas. Trava dura: máximo 2 balões por turno, e o follow-up não dispara se o anterior não teve resposta. Isso é risco de banimento do número, não só de tom (ver `docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md`).

**6. Proibir data relativa na fala com a família.** A regra de datas absolutas hoje só existe para `resumo_anotacao`. 34 mensagens usam "hoje"/"amanhã" — e um follow-up disparado dias depois vira "estamos esperando você hoje à tarde" três dias atrasado (aconteceu com a Suellem).

**7. Bloquear gravação de lixo.** Rejeitar `"A confirmar"`, `"..."`, `"?"` e afins em `crianca_dados.nome` no parser de `sara.ts` — grave `null`. Campo vazio é honesto; placeholder é mentira no CRM.

### P2 — Depois

**8. Rodar o auditor do ADR-007 sobre este corpus.** A infraestrutura já existe (`src/lib/auditor.ts`, `docs/prompt-auditor-sara.md`) e está ociosa. Com as correções acima no ar, use-a para medir o delta em vez de opinar sobre tom.

---

## 4. Patch do `config_ia.system_prompt`

Substituir as três seções abaixo. O resto do prompt está bom.

### Substituir "REGRA DE OURO"

```
# REGRA DE OURO (inegociável)
Toda mensagem termina devolvendo a bola para a família com UMA pergunta simples.
Nunca termine em "estou à disposição", "qualquer coisa me chama" ou frase neutra —
isso mata a conversa.

QUAL pergunta depende do estágio, nesta ordem de prioridade:
1. Se ainda falta nome da criança ou idade → pergunte o dado que falta. Só isso.
2. Se já tem nome e idade mas não sabe o motivo real da busca → pergunte o motivo.
3. Só quando tiver nome + idade → ofereça dois horários concretos de visita.

Nunca ofereça horário de visita antes de saber o nome e a idade da criança.
Convite feito no escuro vira no-show.
```

### Substituir a linha de coleta em "CONDUÇÃO"

```
# DADOS OBRIGATÓRIOS (mesma prioridade da visita)
Antes de convidar para a visita você PRECISA ter: nome da criança e idade.
Antes de a visita acontecer você precisa ter também: período desejado e previsão de início.
Uma pergunta por mensagem. Nunca duas juntas. Nunca repita o que já foi informado.
Se a família perguntar algo, responda primeiro e faça a sua pergunta depois — nunca antes.
Nunca preencha um campo com "A confirmar", "..." ou similar. Se não sabe, deixe vazio e pergunte.
```

### Substituir a seção "PREÇO"

```
# PREÇO — nunca fuja da pergunta
Quando perguntarem valor, responda o valor. Nesta ordem, em até 3 balões curtos:
1. Valide a pergunta em uma linha, usando o nome de quem escreveu.
2. Dê a âncora numérica que está na base de conhecimento e explique em uma frase
   por que ela varia (período e turma). Nunca omita o número.
3. Faça a ponte: o valor exato do plano é fechado na visita.

PROIBIDO: dizer que não existe tabela de preços, dizer que os valores só são
apresentados na visita, ou responder sobre preço sem citar a âncora numérica.
Se a família perguntou o valor e você não citou um número, sua resposta está errada.
Nunca negocie nem ofereça desconto pelo WhatsApp.
```

### Adicionar em "ESTILO"

```
# FORMA DA ESCRITA
Escreva como uma pessoa digitando no WhatsApp, não como um texto publicado.
- Nunca use travessão (— ou –). Use vírgula, ponto ou dois-pontos.
- Nunca escreva colchetes. Se você não sabe o nome da criança, não escreva
  "[nome]" nem "seu(sua) filho(a)" — pergunte o nome.
- Trate a família pelo nome de quem escreveu. Nunca "Papai/Mamãe" quando o nome é conhecido.
- Datas sempre absolutas: "quinta, 30/07 às 9h". Nunca "hoje", "amanhã", "semana que vem".
- Máximo 2 balões por resposta.

Os exemplos deste manual descrevem a INTENÇÃO de cada mensagem. Nunca os copie
como frase pronta — escreva cada mensagem do zero, com as palavras daquela conversa.
```

---

## 5. Como medir se funcionou

Rodar em 14 dias, sobre mensagens posteriores ao deploy:

| Indicador | Hoje | Meta |
|---|---|---|
| Leads engajados com nome + idade | 32% | **> 80%** |
| Mensagens com travessão | 7,7% | **< 1%** |
| Respostas a pergunta de preço que citam número | ~0% | **100%** |
| Mensagens que terminam com pergunta | 34,6% | **> 85%** |
| Duplicatas exatas | 11 | **0** |
| Blocos de 4+ mensagens sem resposta | 29 | **0** |
| Placeholder / "Papai-Mamãe" vazado | 9 | **0** |

Os quatro primeiros são medíveis por SQL direto no corpus, sem julgamento humano. Não peça a ninguém para "achar que melhorou".

---

## 6. Onde eu discordo de você

Você pediu auditoria de **tom**. Tom é o que se vê primeiro e o que menos custa. Se você corrigir só o travessão e o "Papai/Mamãe", a Sara vai soar melhor e continuar perdendo a mesma quantidade de família — porque vai continuar sem perguntar o nome da criança e sem responder quanto custa.

A ordem correta é: **preço → coleta → forma**. O travessão é o item 3 de 3.

E há uma decisão de negócio aqui que não é minha: a `base_conhecimento` diz que valores só são apresentados na visita. Se essa é a política real da escola, o prompt está errado ao prometer R$1.297 e você precisa decidir por qual dos dois fica. Se a política real é ancorar, a KB está desatualizada. **Os dois não podem coexistir** — e enquanto coexistem, a Sara escolhe o pior dos dois mundos: nega a tabela e não dá o número.

---

## 7. Status de implementação — 29/07/2026

**Decisão do gestor:** âncora de preço na **2ª pergunta** (cobre 17 dos 18 leads históricos).
Risco residual aceito: ~3 famílias que somem logo após a primeira pergunta seguem sem número. Medir em 14 dias.

### ✅ Já no ar (mudança de banco entra na hora)

| O que | Onde |
|---|---|
| KB de preços agora contém a âncora R$ 1.297,00 + regra de uso em 2 tempos | `base_conhecimento.c5d89400` |
| Removido o stonewall "valores apresentados durante a visita presencial" | idem |
| Prompt reescrito: Sara 6.1 | `config_ia.id=1` |
| Regra de Ouro agora escalona: dado → motivo → visita. Proibido convidar sem nome e idade | Sara 6.1 |
| Seção DADOS OBRIGATÓRIOS elevada ao mesmo status da visita | Sara 6.1 |
| Seção PREÇO em 2 etapas, proibido negar tabela | Sara 6.1 |
| Nova seção FORMA DA ESCRITA: travessão, colchete e data relativa proibidos; teto de 2 balões | Sara 6.1 |
| Transbordo corrigido: insistência por preço não transfere mais para humano antes de dar o valor | Sara 6.1 |
| Todos os travessões e frases de exemplo literais removidos do prompt inteiro | Sara 6.1 |

Verificado por SQL: prompt sem travessão (0), sem placeholder (0), sem exemplo "papai/mamãe" (0); KB com o número (1); nenhum stonewall residual (0).

**Nota de arquitetura:** o número R$ 1.297 agora existe **só na KB**, e o prompt manda buscá-lo lá. Isso elimina de vez o Conflito 2 — não há mais duas fontes podendo divergir, e a regra anti-alucinação do `sara.ts` passa a autorizar a âncora em vez de censurá-la.

### ⏳ Pendente de deploy (mudança de código)

| O que | Onde |
|---|---|
| `limparTexto()`: converte travessão em vírgula, remove placeholder vazado, preserva a linha em branco entre balões | `src/lib/sara.ts` |
| `limparDados()`: descarta "A confirmar", "...", "?" e afins antes de gravar no CRM | `src/lib/sara.ts` |
| 7 testes com casos reais do corpus | `src/lib/sara.limparTexto.test.ts` |
| `promptPorTrigger()` reescrito: frases prontas viraram descrição de intenção (era a última fonte de cópia literal, escapou por estar em código e não no banco) | `src/lib/followup-regras.ts` |
| `anguloPorTentativa()`: cada toque muda de ângulo em vez de só variar a insistência (Cenário 5 do playbook) | `src/lib/followup-regras.ts` |
| `primeiro_contato` agora exige nome e idade e proíbe convite de visita; `reengajamento` só oferece horário se já souber nome e idade, e proíbe escassez inventada | `src/lib/followup-regras.ts` |
| 9 testes de regressão travando travessão, frase pronta entre aspas e alternância de ângulo | `src/lib/followup-regras.test.ts` |

Deploy (o git auto-deploy está quebrado):
```
cd /d "D:\Claude\Projects\CRM Escola"
npx vitest run
npx vercel@latest --prod
```

> ⚠️ Os testes **não foram executados** nesta sessão: o sandbox Linux ficou indisponível. A lógica foi conferida caso a caso à mão, mas rode o `vitest` antes do deploy.

### 🔲 Não implementado (continuam abertos)

- **P0.4 — duplicação de mensagens** (11 casos, 7 em menos de 5 min). É idempotência no webhook, não no prompt. Precisa investigação em `src/app/api/webhook/whatsapp/route.ts`. **Maior item aberto.**
- **P1.5 — teto de follow-up sem resposta** (29 blocos de 4+). O prompt e o `anguloPorTentativa` agora pedem contenção, mas garantia mesmo só com trava em código no cron.
- **P2.8 — rodar o auditor ADR-007** sobre o corpus pós-correção.

### 🔁 Segunda rodada — conversa da Gislainy (29/07, 10h03)

Primeiro atendimento auditado já com o Sara 6.1 no ar. Confirmou o acerto da correção de coleta e expôs dois defeitos novos.

**O que melhorou:** nome e idade pedidos na PRIMEIRA mensagem, período na segunda, tudo capturado. Era exatamente a falha de 82% dos leads. Nenhum travessão, nenhum placeholder.

**Defeito 1 — convite para daqui a duas horas.** Às 10h03 a Sara ofereceu visita para 12:30 e 13:30 do mesmo dia. Causa: `antecedenciaMin` tem default de 120 min em `gerarSlots`, e o `sara.ts` chamava sem sobrescrever. Agravante: `quantidade:2` sem `maxPorDia` pega os dois primeiros slots livres, que caem no mesmo dia e em sequência — a oferta inteira morre num único "não consigo hoje", que foi literalmente a resposta da mãe.

**Defeito 2 — duas objeções não tratadas.**

A primeira, disfarçada: a mãe pediu Integral e trinta segundos depois perguntou o horário do Estendido. Isso é recuo de período, quase sempre por preço. A Sara respondeu e, **um segundo depois**, reempurrou a mesma visita sem investigar.

A segunda, explícita: *"Vou verificar com o meu marido que dia podemos ir aí"*. A Sara respondeu *"quando tiverem uma data definida, estou aqui"* e encerrou com *"estarei aqui se precisar"* — devolveu o controle da agenda e fechou sem próximo passo, violando a própria Regra de Ouro.

Causa: o tratamento dessas objeções estava no `PLAYBOOK-SCRIPTS-WHATSAPP-SARA.md`, **um documento que a Sara não lê**. Playbook para humanos não vira comportamento de agente.

**Correções:**

| O quê | Onde | Status |
|---|---|---|
| `antecedenciaMin: 720` (12h, "hoje não, amanhã pode") e `maxPorDia: 1` (opções em dias diferentes) | `src/lib/sara.ts` | pendente de deploy |
| 4 testes de regressão, incluindo um que reproduz o bug com o default antigo | `src/lib/disponibilidade.test.ts` | pendente de deploy |
| **Sara 6.2**: seção `# OBJEÇÕES` (cônjuge, opção menor, "vou pensar", "está caro") e `# CONTROLE DA AGENDA` proibindo devolver a escolha de data para a família | `config_ia` | **no ar** |

### 🐛 Bug lateral encontrado pelos testes

`HORA_MIN` em `src/lib/followup-regras.ts` estava em **7**, contra o JSDoc da própria função, o teste da janela e a `POLITICA-ANTI-BLOQUEIO-WHATSAPP.md` — os três fixam **8h**. Alguém baixou a constante e não rodou os testes. Na prática, follow-up automático saía às 7h da manhã, num número que já sofreu bloqueio preventivo. Restaurado para 8h por decisão do gestor em 29/07.

### ⚠️ Débito de verificação

~~O sandbox Linux ficou indisponível durante toda a sessão de 29/07.~~

**Resolvido em 29/07:** `npx vitest run` executado pelo gestor. **55 testes, 54 passando.** Os 32 escritos nesta auditoria (7 `limparTexto` + 9 `promptPorTrigger` + 16 `guardiao-regras`) passaram todos. A única falha era o teste pré-existente da janela comercial, que apontou o bug do `HORA_MIN` descrito acima — corrigido. Rodar de novo após a correção antes do deploy.

---

*Auditoria sobre 402 mensagens da Sara em 44 leads (31/01–28/07/2026), cruzando `mensagens`, `leads`, `criancas`, `familias`, `colunas`, `base_conhecimento` e `config_ia` do projeto `escola-crm`, contra `docs/prompt-auditor-sara.md` (gabarito ADR-007) e `src/lib/sara.ts`.*
