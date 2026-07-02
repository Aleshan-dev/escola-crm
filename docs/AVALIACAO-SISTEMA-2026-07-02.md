# Avaliação do Sistema — Escola CRM (Sara)

**Data:** 2026-07-02
**Painel:** C-Level Squad (CTO, CIO, CAIO, COO) + Vision
**Escopo:** código (Next.js), banco (Supabase), integrações (Evolution, Google, WhatsApp Cloud), operação/deploy.

Legenda de severidade nos erros: 🔴 crítico · 🟠 médio · 🟡 baixo.

---

## Resumo executivo

O produto está **funcional e no ar**, com uma arquitetura de IA madura para o estágio: a Sara decide *o que dizer*, e o sistema decide *quando/se* agir (regras determinísticas). Isso é raro e é o maior acerto do projeto.

Os pontos fracos não estão no produto em si, e sim na **engenharia de suporte**: não há testes automatizados, a observabilidade é mínima, o deploy é frágil (plano Hobby) e há pendências de **segurança** (secret no histórico do Git, políticas RLS permissivas). Nada disso impede operar hoje, mas são os próximos investimentos certos.

Maturidade de engenharia (modelo do CTO, escala 1–4):
- **Entrega:** 2 (deploy manual, sem staging/CI)
- **Qualidade:** 1 (sem testes automatizados)
- **Arquitetura:** 3 (event-driven, domínios claros, ADRs)
- **Observabilidade:** 1 (só `console.error`)
- **Cultura:** 3 (ADRs, decisões documentadas)

---

## ✅ O que está ótimo

1. **Separação IA × regras (CAIO).** A Sara gera texto; o funil, o backoff, o horário comercial e a elegibilidade do follow-up são código determinístico e auditável. "A IA decide o quê, nunca se deve." É a decisão arquitetural mais importante e está correta.
2. **Anti-alucinação (CAIO).** Base de conhecimento injetada no prompt, endereço fixo, e fallback "vou verificar com a equipe" quando não sabe. Reduz risco de a Sara inventar dados para famílias.
3. **Score e temperatura como trigger no banco (CTO).** Recalcula em qualquer caminho de escrita (webhook, kanban, follow-up), sem depender do app. Elegante e consistente — provado na prática (Larama: 72/quente automático).
4. **Motor de follow-up (CTO/COO).** Elegibilidade por etapa, backoff crescente, teto de tentativas → `esgotado`, idempotência (falha de envio não conta tentativa) e auditoria completa em `followup_log`. O cron via GitHub Actions contorna o limite do plano Hobby de forma limpa.
5. **Disciplina de ADR (CTO).** ADR-004 e ADR-005 documentam as decisões com contexto, alternativas e trade-offs. Excelente para um projeto pequeno — reduz o "por que fizemos isso?" no futuro.
6. **Handoff humano (CAIO/CIO).** Captura de mensagens manuais (`fromMe` → `out_humano`) com pausa automática da Sara, e as anotações internas agora alimentam o contexto dela. Human-in-the-loop bem feito.
7. **Config-driven (COO).** Séries, turnos e horários de visita vêm do banco (telas de config), não hardcoded. A Sara oferece 2 horários reais calculados de `horarios_visita` × `tarefas`.
8. **Dados honestos (CIO).** Falha de envio é registrada (`mensagens.status/erro_envio`) em vez de fingir entrega. `acoes_sara` e `eventos_timeline` dão trilha de auditoria.

---

## 🔧 O que pode melhorar

1. **Testes automatizados — o maior gap (CTO).** Zero testes. As peças mais críticas (cálculo de disponibilidade, função de score, elegibilidade do follow-up, dedupe do webhook) não têm rede de segurança. Recomendação: testes unitários para `disponibilidade.ts`, `fn_leads_score` e a lógica de elegibilidade do follow-up. É o investimento de maior retorno.
2. **Deploy e plano (CTO/COO).** Deploy manual (CLI/push), sem staging nem CI, com colisões e a fragilidade do Hobby (bloqueio por uso comercial, limite de cron, exigência de autor do commit). Recomendação: **migrar para o Vercel Pro** (remove bloqueios/limites e dá preview deploys) e adicionar um CI mínimo (typecheck + lint no push).
3. **Observabilidade (CTO).** Só `console.error`. Se o webhook ou o cron falharem, ninguém fica sabendo. Recomendação: alerta simples de falha (ex.: notificação no WhatsApp/e-mail quando o cron retornar erro) e uma tela que mostre falhas de `followup_log`/`mensagens`.
4. **Dois webhooks divergentes (CTO).** O caminho Evolution é completo; o `whatsapp-cloud` é uma versão mais fina (sem persistir família/criança, sem transbordo, sem reset de follow-up). Manter duas implementações que divergem é dívida técnica. Recomendação: unificar a lógica ou marcar explicitamente qual é a oficial.
5. **Performance do banco (CIO/CTO).** Vários foreign keys **sem índice** de cobertura nos caminhos quentes (`leads.familia_id`, `leads.crianca_id`, `mensagens.lead_id`, `anotacoes.lead_id`, `tarefas.lead_id`). Em volume baixo não dói, mas são justamente as consultas de abrir um lead. Além disso, políticas RLS re-avaliam `auth.<fn>()` por linha (`auth_rls_initplan`) — trocar por `(select auth.<fn>())`. Ganhos fáceis.
6. **Governança de dados / LGPD (CIO).** As políticas RLS são "permite tudo" e o app usa a service-role em quase tudo (bypassa RLS). Para um sistema que guarda **dados de crianças**, o ideal é RLS real, menor privilégio e uma postura de retenção/consentimento. LGPD se aplica e crianças são dado sensível.
7. **Estratégia anti-bloqueio do WhatsApp (CAIO/COO).** A dor original foi um bloqueio preventivo. Não há uma política formal de ritmo de disparo/aquecimento. Recomendação: documentar e impor pacing (intervalos aleatórios entre envios, teto diário).
8. **Limpeza (CTO).** `@anthropic-ai/sdk` está nas dependências mas a Sara usa OpenAI (`gpt-4o`); o default de modelo na config menciona `claude-sonnet`. Alinhar para não confundir manutenção futura.

---

## 🛑 Erros a corrigir

1. **🔴 Secret no repositório/histórico (CIO).** O `client_secret_...googleusercontent.com.json` foi removido do HEAD, mas **continua no histórico do Git** e a chave **ainda não foi rotacionada**. Enquanto não rotacionar no Google Cloud + atualizar a env na Vercel, considere-a comprometida. É a correção de maior prioridade. (Tarefa já aberta.)

2. **🟠 View `v_tarefas_lead` com `SECURITY DEFINER` (CIO).** O linter marca como **ERROR** — a view roda com permissões do criador, ignorando RLS de quem consulta. Recriar como `security_invoker`.

3. **🟠 `fn_leads_score()` exposta como `SECURITY DEFINER` via RPC (CIO).** Introduzida na migration de score: hoje `anon` e `authenticated` podem chamá-la por `/rest/v1/rpc/fn_leads_score`. É só um trigger — deve ter o `EXECUTE` revogado de `anon, authenticated`. (Corrijo isso rápido se você autorizar.)

4. **🟠 Inconsistência de "Período" na tela do lead (bug de dados).** O `LeadDetailModal` ainda usa `PERIODOS = ['matutino','vespertino','integral']`, que **não são** os turnos reais da escola (`Integral/Estendido/Parcial`). Removemos o `check` no banco, mas a UI ainda oferece valores errados — quem editar o período no modal grava algo divergente do que a Sara e os turnos usam. Correção: carregar os turnos do banco (como a Sara faz) em vez da lista fixa.

5. **🟡 `integracao_google` com RLS habilitado e sem policy (CIO).** Guarda os tokens do Google. Hoje só é acessada via service-role, mas deveria ter uma policy explícita (deny) para não depender de configuração implícita.

6. **🟡 Políticas RLS "sempre verdadeiras" + funções com `search_path` mutável + proteção de senha vazada desligada (CIO).** Conjunto de avisos de segurança do linter. Individualmente baixos, juntos formam uma postura frouxa. Endereçar em lote.

7. **🟡 Divergência do webhook `whatsapp-cloud` (CTO).** Não persiste família/criança, não faz transbordo nem reset de follow-up. Se algum dia migrar para a API oficial, recursos "somem" silenciosamente. Corrigir a paridade ou deprecar.

---

## 📣 Visão de Marketing (CMO)

O CRM é, na prática, a **máquina de conversão e nutrição** da escola: captura o lead no WhatsApp, qualifica, agenda a visita e reengaja. Avaliando por essa lente:

**✅ O que está ótimo**
1. **Funil construído de baixo para cima.** O sistema investe primeiro onde o CMO manda investir — **conversão e nutrição** (follow-up, agendamento, reengajamento) — em vez de despejar tráfego num funil furado. As etapas (Capturados → Em Atendimento → Visita Agendada → Realizada → Matriculados) são um funil de demanda real.
2. **Consistência que compõe.** O follow-up automático elimina o "lead esquecido" — a maior fonte de perda em venda consultiva. Consistência > atos aleatórios de marketing.
3. **Marca em cada toque.** A Sara tem voz definida (acolhedora, cristã); cada mensagem no WhatsApp é um momento de marca. "Marca é uma promessa cumprida com consistência."
4. **Speed-to-lead.** Resposta imediata no WhatsApp — fator decisivo de conversão em educação.
5. **Início de segmentação.** Score/temperatura (frio/morno/quente) é a base de uma segmentação comportamental para priorizar o atendimento.

**🔧 O que pode melhorar**
1. **Atribuição de origem (crítico p/ marketing).** `familias.origem` é quase sempre "whatsapp" — não há de **qual canal/campanha/anúncio** o lead veio. Sem isso, não dá para calcular **CAC** nem saber onde investir verba. Recomendação: rastrear a origem no ponto de entrada (ex.: anúncios *click-to-WhatsApp* com parâmetro de referência) e reportar por `origem`.
2. **Dashboard de funil.** Existem `metas_crescimento` e a tela `/inicio`, mas faltam as **taxas de conversão por etapa** (Capturados→Visita→Matrícula), no-show de visita, tempo de resposta e **taxa de resposta ao follow-up**. Métricas que conectam à receita.
3. **Etapa de advocacia inexistente.** Depois da matrícula, nada transforma os pais em promotores. Em escola, **indicação/boca a boca é o canal nº 1**. Recomendação: fluxo de indicação + NPS pós-matrícula.
4. **Posicionamento afiado.** Os diferenciais (até 10 por turma, 2 educadoras, cristã, câmeras, app, alimentação) existem na base, mas não estão empacotados numa frase de posicionamento que a Sara lidere. Recomendação: definir o posicionamento (para quem, categoria, benefício-chave, razão para crer) e refletir na abertura da Sara.
5. **Nutrição com valor.** O follow-up hoje é reengajamento ("vamos agendar?"). Falta conteúdo de valor (tour virtual, depoimentos, dica pedagógica) para nutrir quem ainda não decidiu.

**🛑 Erros a corrigir**
1. **🟠 Origem do lead praticamente desconhecida (erro de medição).** Sem canal/campanha, é impossível alocar verba ou medir CAC — lacuna real para um negócio que anuncia.
2. **🟠 O follow-up não é medido até o resultado.** Temos `followup_log` (enviado/falhou), mas não se o follow-up **gerou resposta/visita/matrícula**. Sem ligar follow-up → desfecho, não se prova o ROI da automação (reforça o ponto do CAIO).

---

## Plano priorizado (visão COO)

**Fazer primeiro (segurança e correção):**
1. Rotacionar a chave do Google + limpar o secret (erro #1).
2. Corrigir os 3 itens rápidos de segurança/DB: `v_tarefas_lead`, `fn_leads_score`, RLS de `integracao_google` (erros #2, #3, #5).
3. Corrigir o dropdown de Período no modal do lead (erro #4).

**Fazer em seguida (robustez):**
4. Migrar para o Vercel Pro + CI mínimo (melhoria #2).
5. Índices nas foreign keys quentes + otimizar RLS (melhoria #5).
6. Alerta de falha de cron/webhook (melhoria #3).

**Fazer quando puder (maturidade):**
7. Testes unitários das peças críticas (melhoria #1).
8. Unificar os dois webhooks (melhoria #4 / erro #7).
9. Política formal anti-bloqueio de WhatsApp (melhoria #7).

**Crescimento (visão CMO):**
10. Rastrear origem/campanha do lead + reportar CAC por canal (marketing #1).
11. Dashboard de funil com taxas de conversão por etapa e efetividade do follow-up (marketing #2).
12. Fluxo de indicação + NPS pós-matrícula (advocacia) e posicionamento afiado na abertura da Sara (marketing #3 e #4).

---

*Observação: esta avaliação reflete o estado em 2026-07-02. Recomenda-se revisá-la a cada ciclo relevante de mudanças.*
