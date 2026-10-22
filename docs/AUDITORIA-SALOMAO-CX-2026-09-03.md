# Auditoria de CX — Salomão (atendente de matriculados)

*03/09/2026 · Auditor Sênior de CX · Fonte: `crm.vw_conversas_salomao` (banco vivo SGEI/crm) · Amostra: 3 conversas reais*

Primeira auditoria possível **depois** do Eixo A: agora as mensagens do Salomão
são isoláveis (`agente='salomao'`). Gabarito persistido em `crm.salomao_auditoria`.

## Veredito geral

**Compliance: sólido. Polimento de CX: há folga.** Nas 3 conversas o Salomão
passou nos 5 critérios binários de segurança (não revelou sem 2º fator, não ecoou
CPF, não prometeu desconto, registrou recado quando devia, apresentou-se como
virtual). **Nenhuma quebra de LGPD/segurança.** As falhas são de **tom, timing e
proatividade** — e três merecem ação técnica (não só de prompt):

1. **Tratamento de comprovante é reativo e frio** (recorrente nas 3).
2. **Saudação genérica quando a intenção já está clara** ("quero o boleto" → "como posso ajudar?").
3. **Dois achados de acurácia:** nome trocado ("Ana" para a família da Karol) e **PIX em excesso** (Jéssica pediu setembro, recebeu setembro + outubro).

---

## Conversa 1 — Walber Reis (Sebastião) · lead `9935d07f`

**Resumo:** responsável manda comprovante já pago; semanas depois pede "o boleto
deste mês"; após 2º fator, recebe situação financeira e PIX. Fecha com PIX
entregue com sucesso.

**Diagnóstico de falhas**
- **Timing perdido (28/08):** à mensagem "O boleto deste mês" (intenção clara de
  2ª via/pagamento), o Salomão respondeu "Como posso ajudar você hoje?" — um passo
  a mais de atrito antes de pedir o CPF.
- **Dessincronia (05/08):** o responsável avisou "foi pago dia 29" e mandou
  comprovante; o Salomão respondeu com saudação genérica e, em seguida, um
  comunicado automático "se já efetuou o pagamento, desconsidere" — soa robótico e
  fora de contexto (ele *acabara* de dizer que pagou).

**Refatoração do diálogo** (28/08, ao receber "O boleto deste mês")
> Claro, Sebastião! 💛 Para te enviar a 2ª via com segurança, me confirma só os 3
> primeiros dígitos do CPF do responsável? Aí já te mando o PIX na hora.

**Otimização do prompt base**
> Quando o responsável já sinalizar intenção financeira clara (ex.: "quero o
> boleto", "2ª via", "o boleto deste mês", "como pago"), NÃO responda com
> saudação genérica: vá direto ao 2º fator (peça os 3 dígitos do CPF), explicando
> que é por segurança. A saudação de abertura só na 1ª mensagem da conversa.

**Gabarito:** 5/5. Falhas de tom/timing, não de compliance.

---

## Conversa 2 — Karol Moura (aluno João Lucas) · lead `7f0ab94e`

**Resumo:** manda comprovante de mensalidade; depois trata da contribuição do Dia
dos Pais, com dois transbordos para a secretaria (que respondeu bem).

**Diagnóstico de falhas**
- **Nome trocado (ACURÁCIA):** o Salomão chamou a responsável de **"Ana"**
  ("Olá, Ana!") sendo o contato Karol Moura / aluno João Lucas. Provável origem no
  `{primeiro_nome}` do responsável financeiro cadastrado divergir de quem
  conversa — ou dado errado. **Risco real de quebra de confiança.**
- **Passividade repetida:** "a secretaria vai verificar" apareceu 3x seguidas em
  contextos diferentes (14/08 e 15/08), com a família esperando ("Aguardo"). O
  encaminhamento está certo; a *repetição literal* soa automática.

**Refatoração do diálogo** (15/08, "qual horário do evento hoje?")
> Bom dia, Karol! 💛 Já pedi para a secretaria te confirmar o horário certinho —
> ela responde por aqui em instantes. Enquanto isso, posso adiantar alguma outra
> coisa pra você?

**Otimização do prompt base**
> Nunca use o mesmo texto de encaminhamento duas vezes seguidas — varie e
> personalize ("já pedi para a secretaria…", "a coordenação te retorna por
> aqui…"). Sempre que possível, ofereça algo enquanto o humano não responde.
> **Sobre o nome:** use apenas o primeiro nome vindo da identificação do Arca; se
> houver divergência entre quem escreve e o cadastro, prefira um vocativo neutro
> ("Oi! 💛") a arriscar o nome errado.

**Gabarito:** 5/5. Achado de acurácia (nome) é de dado/config, fora dos 5 binários.

---

## Conversa 3 — Jéssica Cunha (aluna Sofia) · lead `d9bfb40c`

**Resumo:** manda comprovante; declina o evento com um motivo pessoal; semanas
depois pede o PIX de setembro e recebe.

**Diagnóstico de falhas**
- **PIX em excesso (ACURÁCIA/TÉCNICO):** a família pediu **"a chave pix da parcela
  de setembro"**; o Salomão enviou **setembro E outubro** (2026-09 e 2026-10).
  O backend `pix` deveria filtrar competência ≤ mês atual — enviar outubro
  antecipado não foi pedido e pode confundir. **Verificar o filtro de competência
  do recurso `pix` no Arca / a passagem de `competencia` pelo `salomao.ts`.**
- **Recado sob pergunta (03/08):** ao receber um comprovante, o Salomão *perguntou*
  "Você gostaria que eu registrasse um recado?" em vez de registrar
  proativamente. Para comprovante, o padrão certo é registrar e tranquilizar.

**Ponto positivo a preservar:** a resposta ao "papai da Sofia não mora na cidade,
por isso ela não vai participar" foi impecável — acolheu, não insistiu na
cobrança do evento, encaminhou. É a voz da casa no melhor.

**Refatoração do diálogo** (02/09, "Quero a chave pix da parcela de setembro!")
> Claro, Jéssica! 💛 Por segurança, me confirma os 3 primeiros dígitos do CPF do
> responsável? Já te envio **o PIX da mensalidade de setembro** na sequência.

*(e enviar somente setembro, salvo pedido explícito de outros meses.)*

**Otimização do prompt base**
> Quando o responsável pedir o PIX de um mês específico ("parcela de setembro"),
> gere e envie **apenas aquele título**; não antecipe meses futuros a menos que
> ele peça. Ao receber um comprovante de pagamento, registre o recado para a
> secretaria de forma **proativa** (sem perguntar se pode) e tranquilize:
> "Já pedi para a secretaria conferir e dar baixa — o sistema atualiza sozinho
> quando confirmar. 💛".

**Gabarito:** 5/5. Achado técnico do PIX exige verificação no Arca.

---

## Padrões recorrentes → ações

| Achado | Frequência | Tipo | Ação |
|---|---|---|---|
| Comprovante tratado de forma reativa/fria | 3/3 | Prompt | Registrar recado proativo + tranquilizar (prompt B2, sem deploy) |
| Saudação genérica com intenção já clara | 2/3 | Prompt | Ir direto ao 2º fator (prompt B2) |
| Comunicados/régua interleaved fora de ordem | 3/3 | Técnico | Marcar subtipo (D2) e avaliar suprimir/ordenar broadcast em conversa ativa |
| Nome trocado ("Ana") | 1/3 | Dado/Config | Auditar fonte do `{primeiro_nome}`; vocativo neutro em divergência |
| PIX em excesso (mês não pedido) | 1/3 | Técnico (Arca) | Verificar filtro de competência do recurso `pix` |

**Boa notícia:** as duas primeiras (as mais frequentes) resolvem-se **editando
`config_ia.salomao_system_prompt`** — que o Eixo B2 acabou de tornar editável sem
deploy. As técnicas (subtipo, PIX, nome) entram em D2/D3.
