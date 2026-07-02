# ADR-005: Captura de Mensagens Manuais (fromMe) do WhatsApp

**Status:** Accepted
**Autor:** Painel C-Level (CTO Architect, CIO Engineer, CAIO Architect, COO Orchestrator) + Aleshan
**Data:** 2026-07-02
**Relacionado:** ADR-004 (Follow-up automático da Sara)

## Contexto

O CRM captura as mensagens do WhatsApp via webhook do Evolution (`/api/webhook/whatsapp`). O webhook, porém, **descartava de propósito** todas as mensagens com `key.fromMe === true` (`return ignored('fromMe')`).

Na prática isso significa que **respostas digitadas manualmente pela equipe direto no celular** (fora da tela de chat do CRM) nunca entravam no banco. Descobrimos isso ao reconstruir a conversa da lead "Larama": todo o atendimento manual do diretor (nome da criança — Théo —, valor da mensalidade, lista de material G2, decisão pendente com o pai) estava **ausente do banco**, e o `findMessages` do Evolution também não retornou essas mensagens (só as enviadas via API).

Consequências do gap:
- **Contexto da Sara degradado:** sem o histórico manual, o follow-up automático sairia genérico (a Sara perguntaria coisas já respondidas). Dado incompleto = IA pior.
- **Fonte da verdade fragmentada:** a conversa fica dividida entre o celular e o CRM (data silo).
- **Conflito humano × IA:** se um atendente responde pelo celular e a Sara também responde, os dois se atropelam.
- **LGPD:** conversas com dados de famílias espalhadas em celulares pessoais, fora do sistema governado.

## Decisão

Capturar as mensagens `fromMe` no webhook, distinguindo a origem:

1. **Dedupe:** se o `whatsapp_message_id` já existe em `mensagens`, a mensagem foi enviada pela própria Sara via API (já registrada) → ignora.
2. **Mensagem manual** (`fromMe` com ID novo) → grava como `direcao = 'out_humano'` vinculada ao lead **e pausa a Sara** naquele lead (`ia_ativa = false`), registrando um evento `status_ia` na timeline.

O botão "Atualizar conversa" + auto-sync (endpoint `/api/admin/sync-chat`) permanece como **rede de segurança** (defense-in-depth) para reconciliar o que escapar do tempo real.

## Alternativas consideradas

- **Só o sync periódico (`findMessages`):** rejeitado como solução única — o `findMessages` do Evolution não retornou as mensagens manuais do celular; não é confiável sozinho.
- **Só configuração do Evolution:** necessário, mas insuficiente — mesmo que o Evolution emita os eventos, o webhook precisa parar de descartá-los. Fica como passo complementar (verificar assinatura de `MESSAGES_UPSERT`).
- **Só processo (proibir resposta pelo celular):** rejeitado como solução única — depende de disciplina humana e não captura o histórico existente. Mantido como recomendação operacional (COO), não como controle técnico.
- **Capturar sem pausar a Sara:** rejeitado — sem o handoff, IA e humano respondem em paralelo. O guardrail de pausa (CAIO) é parte da decisão.

## Consequências

**Positivas:**
- Conversa completa no CRM em tempo real → contexto rico para a Sara (follow-up, score, temperatura).
- Handoff limpo: humano assume, Sara pausa automaticamente.
- Fonte única da verdade; menos exposição de dados (LGPD).

**Negativas / custos:**
- Depende de o Evolution emitir eventos `fromMe` no webhook (config a verificar).
- A pausa automática exige que a equipe reative a Sara pelo toggle ao encerrar o atendimento manual (comportamento a comunicar).
- Uma consulta extra de dedupe por mensagem `fromMe` (custo desprezível).

**Trade-off aceito:** um pouco mais de lógica no webhook em troca de captura completa, handoff seguro e fonte única — correto para um sistema que atende famílias e alimenta uma IA de atendimento.

## Próximos passos

1. Deploy da alteração no webhook. ✔ (implementado)
2. **[CIO]** Verificar no painel do Evolution se o webhook assina `MESSAGES_UPSERT` (incluindo enviadas) e se o armazenamento de mensagens está ligado.
3. **[COO]** Padronizar a resposta pela tela de chat do CRM (celular = exceção) e acompanhar a métrica "% de mensagens enviadas pelo CRM vs. celular".
4. **[CAIO]** Monitorar a qualidade do follow-up agora que o contexto manual é capturado.
