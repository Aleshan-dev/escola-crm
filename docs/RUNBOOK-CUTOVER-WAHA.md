# Runbook — Cutover do WAHA (número oficial: Deskcomm → legado escola-crm)

> Objetivo: fazer o número oficial de atendimento **556892094674** parar de ser
> atendido pelo DeskcommCRM e passar a ser atendido pelo **escola-crm legado**,
> sem os dois responderem ao mesmo tempo. Escrito em 2026-10-15 com a topologia
> real observada. **Executado por você na VM/painéis — eu não acesso a VM.**

## Topologia atual (confirmada)

- **Servidor WAHA:** `https://waha.34-60-113-102.sslip.io` (dashboard em `/dashboard/`).
- **Sessão oficial:** `org_85191f79_191422` — número **556892094674** — status **WORKING** —
  hoje faz **webhook para o DeskcommCRM** (token de canal `f8da98…`).
- **Legado** (`crm.integracao_waha`): aponta para o **mesmo** servidor WAHA, mas para a
  sessão **`Salomao-crm`** (secundária/disparos). Endpoint de entrada do legado:
  **`/api/webhook/waha`** (aceita eventos `message` e `message.any`; exige
  `?secret=<WAHA_WEBHOOK_SECRET>` se essa env estiver setada no legado).

## ⚠️ Pré-requisitos (fazer ANTES do cutover)

1. **Legado deployado com o código novo.** Maestro + roteador + prompts estão na branch
   `feat/maestro-roteador`, **ainda não no ar**. Deployar primeiro (ver `AGENTS.md` do
   legado). Sem isso, o cutover entrega o atendimento à versão antiga.
2. **DECISÃO de arquitetura — por qual sessão o legado ENVIA a resposta da Sara.**
   O legado tem UMA sessão WAHA configurada (`crm.integracao_waha.session`), hoje
   `Salomao-crm`. Para atender o número oficial, as respostas da Sara precisam sair pela
   sessão **`org_85191f79_191422`**. Duas opções:
   - **(A) Apontar o legado para a sessão oficial** (`integracao_waha.session =
     org_85191f79_191422`). Simples, mas o legado passa a usar UMA sessão para tudo —
     confirme se os disparos do Salomão devem mesmo sair por esse número ou se precisam
     continuar no chip secundário (hoje `Salomao-crm`). Se precisarem separar, o legado
     precisa de suporte a 2 sessões (ajuste de código — não trivial).
   - **(B) Restaurar atendimento no WhatsApp Cloud (Meta)** — desenho original do legado
     (atendimento na Cloud, disparos no WAHA). Exige migrar o número de volta para a Cloud
     API (embedded signup/number migration). Mais trabalhoso; só se você quiser voltar ao
     desenho antigo.
   > Recomendação: **(A)** para o cutover rápido, confirmando a política de disparos. Deixe
   > decidido ANTES de repontar o webhook.
3. **Chave da API do WAHA** válida no legado para a sessão oficial (`integracao_waha.api_key`).
4. **Janela de corte** combinada (haverá ~minutos em que convém não receber mensagens),
   e o backup/al estado do Deskcomm ciente.

## Passo a passo do cutover

### 1. Configurar o legado para a sessão oficial (opção A)
Na tela do legado **Configurações → WAHA** (`/app/configuracoes/waha`), ou direto no banco:
- `api_url` = `https://waha.34-60-113-102.sslip.io` (já está)
- `session` = `org_85191f79_191422`
- `api_key` = (a chave do WAHA)
Depois, registrar o webhook do legado no WAHA pela própria tela/rota
`/api/waha/webhook-register` (ela escreve o webhook da sessão apontando para o legado) —
**ou** faça manualmente no passo 2.

### 2. Repontar o webhook da sessão no WAHA
No **dashboard do WAHA** (`https://waha.34-60-113-102.sslip.io/dashboard/`) → sessão
`org_85191f79_191422` → configuração de **webhooks**:
- Trocar a URL do webhook (hoje apontando pro Deskcomm) para:
  `https://<URL_DO_LEGADO>/api/webhook/waha` (+ `?secret=<WAHA_WEBHOOK_SECRET>` se o legado
  exigir).
- Eventos: manter **`message`** e **`message.any`** (o legado usa os dois; `message.any`
  captura respostas manuais pelo celular — ADR-005).
- Se o Deskcomm usa HMAC no webhook, o legado não exige assinatura por padrão; confira o
  `WAHA_WEBHOOK_SECRET` do legado em vez de HMAC.
> `<URL_DO_LEGADO>` = domínio do projeto `escola-crm` na Vercel (ex.: `escola-crm.vercel.app`
> ou o domínio custom). Confirme no painel da Vercel.

### 3. Desligar a IA do Deskcomm nesse número (dupla segurança)
Mesmo com o webhook repontado, garanta que o Deskcomm não responde:
- **No banco do Deskcomm** (`vdtlfz`, schema public), marcar o canal como desativado:
  ```sql
  update channel_sessions
     set metadata = coalesce(metadata,'{}'::jsonb) || '{"disabled": true}'::jsonb
   where waha_session_name = 'org_85191f79_191422';
  ```
  (O drain do Deskcomm pula canal desativado: "Canal desativado → consome, sem job".)
- E/ou **parar a sessão** no WAHA/Deskcomm para esse número, se preferir corte duro.
> Não apague a sessão nem o número no WAHA — só repontar o webhook e desativar no Deskcomm.
> Assim o rollback é imediato.

## Verificação (logo após o corte)
1. Envie uma mensagem de teste de um número comum para **556892094674**.
2. No legado: a mensagem deve aparecer (tabela `crm.mensagens` / tela de atendimento) em
   ~15–60 s, e a **Sara deve responder pelo próprio número oficial**.
3. No Deskcomm: **não** deve surgir resposta nem job para essa conversa.
4. Confira nos logs do legado (`crm.alertas_sistema`) se não há erro de envio/webhook.

## Rollback (se algo der errado)
1. No WAHA, repontar o webhook da sessão `org_85191f79_191422` de volta para a URL do
   Deskcomm (token `f8da98…`).
2. No Deskcomm, reativar o canal:
   ```sql
   update channel_sessions
      set metadata = metadata - 'disabled'
    where waha_session_name = 'org_85191f79_191422';
   ```
3. Voltar `crm.integracao_waha.session` do legado para `Salomao-crm` se tiver mudado.
O número volta a ser atendido pelo Deskcomm em minutos.

## Riscos e lembretes
- **Dois respondendo:** o maior risco é esquecer o passo 3 — repontar o webhook mas o
  Deskcomm continuar ativo. Faça os passos 2 e 3 juntos.
- **Envio pela sessão errada:** se o legado continuar com `session = Salomao-crm`, a Sara
  responderia pelo número errado. Passo 1 é obrigatório.
- **Ban anti-spam:** não dispare em massa pelo número oficial logo após o corte.
- **Segurança:** rotacionar as chaves `service_role` do Supabase que vazaram no chat
  (sgei e escola-crm) e apagar `C:\Users\Aleshan\sgei-key.txt`.
