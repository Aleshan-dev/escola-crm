# Jornada de Atendimento da Sara — WhatsApp (Colégio Pequenos Guardiões)

> Do primeiro contato até a matrícula, com fluxo anti-no-show integrado.
> Estrutura: o **cron decide QUANDO** disparar (regras determinísticas); a **Sara decide O QUE dizer** (gera o texto no padrão JSON). Mesma filosofia do ADR-004.

---

## Princípios de copy (base de tudo)

1. WhatsApp é relacionamento — nada de cara de broadcast.
2. A primeira linha decide se lê ou arquiva: pessoal e relevante (cite a criança / a turma).
3. Nunca mandar tudo de uma vez — sequência de mensagens curtas converte mais.
4. Sempre terminar com pergunta aberta ou instrução clara.
5. **Posicionamento:** liderar com *segurança + atenção individual (turma de no máx. 10) + ambiente cristão*. Escassez ("vagas limitadas") é tática de CTA, não o argumento central — usar só quando for verdade.

---

## FASE 1 — Reengajamento (lead interessado que não fechou)

**1.1 Abertura** — máx 3 linhas, primeira linha sobre a criança, não sobre a escola
> Oi, [Nome]! A [criança] já está pra entrar na turma do [série/idade] ano que vem, né?
> Aqui é a Sara, do Colégio Pequenos Guardiões 💛
> Vocês ainda estão buscando escola pra ele(a) esse ano?

**1.2 Produto** — máx 4 linhas
> Deixa eu te contar por que as famílias escolhem a gente 🙂
> Escola cristã, turmas de no máximo 10 crianças por sala — atenção de verdade, individual.
> Sistema Acrescer, alimentação preparada aqui na escola e horários Parcial, Estendido ou Integral.
> Ambiente seguro e acolhedor, do berçário aos 5 anos.

**1.3 Prova / credibilidade** — usar prova REAL (não estatística inventada)
> Temos famílias que estão com a gente desde o berçário e não trocam por nada.
> [Depoimento curto de uma mãe — 1 frase] — "[citação real]", mãe da/do [nome].

> ⚠️ Substituir pelo depoimento verdadeiro. Para este público (decisão emocional, alta confiança),
> voz de cliente + tempo de casa + segurança convertem mais do que "X% das vagas fecharam".

**1.4 CTA → agendar visita** — instrução clara + reduzir fricção
> A melhor forma de decidir é conhecer de pertinho.
> Me manda **SIM** que eu te envio os valores e já separo um horário pra sua visita 💛

---

## FASE 2 — Confirmação e lembretes (anti-no-show)

> **Este é o coração do sistema.** O gargalo real do funil não é agendar — é comparecer.
> O objetivo é aumentar o compromisso e reduzir o atrito entre o "SIM" e a porta da escola.

**2.1 Confirmação imediata** — dispara no ato do agendamento (T+0)
> Prontinho, [Nome]! Sua visita está marcada 💛
> 📅 [dia], às [hora] — [endereço]
> Separei um tempo pra você conhecer a salinha da [criança] e tirar todas as dúvidas. Pode levar ele(a)!

**2.2 Lembrete véspera** — dispara ~18h do dia anterior (T-1d) — **pede confirmação ativa**
> Oi, [Nome]! Passando pra confirmar sua visita amanhã, [dia], às [hora] 🙂
> Deixei a sala da [criança] reservada pra você conhecer. Consegue confirmar que vem? Responde **SIM** pra mim.

**2.3 Lembrete do dia** — dispara 3h antes (T-3h)
> É hoje! Te espero às [hora] 💛
> 📍 [link do mapa]
> Qualquer imprevisto na chegada, é só me chamar por aqui.

---

## FASE 3 — Resgate de no-show

**3.1 Resgate** — dispara 2h após o horário, se não compareceu — tom acolhedor, NUNCA cobrança
> Oi, [Nome]! Senti sua falta hoje 🙂 Sei que a rotina com criança pequena é corrida — acontece.
> Quer que eu remarque pra outro dia? Me diz dois horários que funcionam que eu já deixo separado.

**3.2 Última tentativa** — dispara +48h sem resposta ao resgate
> [Nome], ainda dá tempo de conhecer a escola antes das vagas da turma da [criança] fecharem.
> Quer que eu veja um horário essa semana?

---

## FASE 4 — Follow-up de silêncio (quem parou de responder antes de agendar)

**4.1** — 24-48h após a última mensagem sem resposta, máx 2 linhas
> Oi, [Nome]! Só passando pra saber se ainda faz sentido pra vocês esse ano 🙂
> Se quiser, deixo uma vaga reservada pra [criança] enquanto conversamos. Posso?

---

## Objeção de preço ("quanto custa?" / "tem desconto?")

> Reframe valor antes do número; puxar pra visita. Lead que trava no preço tende a virar perda —
> tratar com cuidado.

> Ótima pergunta! O valor depende da turma e do horário que fizer mais sentido pra vocês
> (Parcial, Estendido ou Integral).
> Mais do que o preço, o que entregamos é turma pequena, atenção individual e um ambiente cristão
> seguro — o que faz diferença de verdade no dia a dia do(a) seu(sua) filho(a).
> Me diz a idade dele(a) que passo o valor certinho — e sim, temos condição pra matrícula antecipada.
> Melhor ainda: na visita eu te mostro tudo de perto. Quer que eu já reserve um horário?

---

## Versão para grupo de clientes (renovação — separado de captação)

> Não misturar renovação, indicação e captação na mesma mensagem — dilui. Cliente atual recebe
> pertencimento, não venda fria. Cuidado com "condição de quem é de casa": não corroer a integridade de preço.

> Famílias Pequenos Guardiões, bom dia! 💛
> As renovações de matrícula [ano] já estão abertas e as vagas por sala são limitadas (máx. 10 crianças).
> Pra garantir a mesma turma e horário da [criança], me chama no privado que eu já cuido da sua renovação.
> É só responder aqui ou me chamar 🙏

---

## Regras determinísticas para a Sara / cron

| Gatilho | Quando dispara | Ação no funil |
|---|---|---|
| Confirmação imediata | No agendamento (T+0) | mantém em "Visita agendada" |
| Lembrete véspera | ~18h do dia anterior (T-1d) | marca `visita_confirmada` se responder SIM |
| Lembrete do dia | 3h antes (T-3h) | — |
| Resgate no-show | 2h após o horário, se faltou | move p/ "Reagendar" (NUNCA "Perdidos") |
| Última tentativa | +48h sem resposta ao resgate | após isso → `followup_status = esgotado` |

**Ramificações:**
- **Confirmou na véspera** → segue pro lembrete do dia normalmente.
- **Não respondeu à véspera** → dispara o lembrete do dia mesmo assim e marca o lead como *risco de no-show* (staff pode priorizar ligação humana).
- **Não compareceu** → vai pra "Reagendar" e entra no resgate. **No-show ≠ perda.**
- **Máximo 2 reagendamentos.** Depois: `esgotado` e para (evita virar insistência).
- **Janela comercial 08h–20h** em todos os disparos (timezone da escola).
- Todo disparo vira linha no `followup_log` para auditoria.

---

## Métricas que importam

- **Taxa de comparecimento** = visitas realizadas ÷ agendadas *(KPI-chave — o gargalo mora aqui)*
- **Taxa de recuperação de no-show** = reagendou e compareceu ÷ no-shows
- Taxa de resposta da abertura → taxa de "SIM" → comparecimento → visita→matrícula

Se a confirmação da véspera subir o comparecimento, a alavanca foi encontrada.
