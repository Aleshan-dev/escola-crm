# Fase 0 — Runbook executável (fundação do cutover)

> **Data:** 2026-09-28 · Companheiro de [MAPA-PARIDADE-DESKCOMM.md](./MAPA-PARIDADE-DESKCOMM.md)
> **Meta da fase:** ter um DeskcommCRM (fork da `main` atual) rodando em staging, com o umbilical SGEI plugado e o mapa re-baselineado — **sem tocar produção**.
> **Regra de ouro:** todo comando roda contra o **fork da `main` clonada**, nunca contra o snapshot `CRM ESCOLA 2` (que é de ago e está defasado). Nomes de script/pasta abaixo vêm do snapshot; **confirme os equivalentes no clone** (`hostgator-setup-kit/`, `docs/deploy-selfhost/`, `docs/SETUP.md`).

> **Estratégia de subida (decidido 28/09):** **genérico primeiro, adaptações por cima — não big-bang.** Subir o DeskcommCRM genérico (já testado/CI-verde) na VPS e deixá-lo verde ANTES de qualquer lógica de escola, para separar risco de infra de risco de domínio. Junto com o boot, só o **esqueleto do overlay** (pastas + convenção de migration + módulos vazios), sem lógica. As adaptações entram vertical a vertical (Fases 1→5), cada uma diffada contra uma base que funciona. Staging **não precisa ser útil para a escola** — produção segue no sistema no ar (Vercel + SGEI) até a Fase 7.

---

## 0. Pré-requisitos (acessos que você precisa ter em mãos)

- [ ] Conta GitHub com permissão de **fork** de `melgarafael/DeskcommCRM`.
- [ ] **VM DEDICADA — Oracle Cloud Always Free (ARM Ampere A1)**, `deskcomm-staging` (ex.: 4 OCPU / 24 GB, grátis). Escolhido em 28/09 por ser gratuito e com RAM de sobra. **NÃO** usar a VM do WAHA de produção (box de 1 GB, cairia por OOM — ver §2). O free tier do GCP (1× e2-micro/1 GB) já está consumido pelo WAHA de produção e não aguenta o stack.
      - ⚠️ **ARM ⇒ build da fonte.** A imagem pronta `ghcr.io/melgarafael/deskcommcrm:*` é amd64 e **não roda em ARM**; usar o `build:` do compose. Conferir versão ARM das imagens de base (WAHA, redis, srh, caddy).
      - Abrir **80/443** em **dois lugares**: Security List/NSG da VCN **e** o firewall local da instância (Oracle sobe com iptables restritivo).
      - Capacidade ARM Always Free costuma faltar ("Out of host capacity") — pode ter que repetir ou trocar de AD/região.
      - Domínio de staging: `<IP-da-VM>.sslip.io` (resolve na hora, sem propagação). Domínio real fica pra Fase 7.
- [ ] **Supabase novo** (projeto dedicado ao DeskcommCRM — NÃO o SGEI, NÃO o escola-crm espelho). Usar a **connection string do Session pooler (IPv4)**, não a Direct (a VPS é IPv4-only; a Direct é IPv6 e trava a instalação).
- [ ] ~~Upstash Redis~~ **não precisa** — o `docker-compose.prod.yml` já sobe `redis:7-alpine` + `serverless-redis-http` (fala o REST do Upstash sobre o redis local). Zero serviço externo de Redis.
- [ ] **Chip de teste de WhatsApp** (número separado do de produção). **O WAHA vem no próprio compose do DeskcommCRM** (`devlikeapro/waha`, já com `sha512:` na key + webhook HMAC — exatamente o que o app espera). Ou seja, a instalação de staging **já traz o seu próprio WAHA isolado**; não é preciso montar um 2º container à mão. ⚠️ O cuidado passa a ser **colisão de porta/volume/nome** com o WAHA de produção que já roda na VPS (ver Passo 3).
- [ ] Credenciais **SGEI** já existentes (as 4 do bloco abaixo — pegue do `.env.local` do sistema no ar).
- [ ] Credenciais **Google OAuth** (client id/secret) para a frente de agenda.
- [ ] Chaves de IA: AI Gateway (Vercel) **ou** Anthropic direto / OpenRouter.
- [ ] (Opcional) Sentry DSN.

---

## Instalação oficial vs. modificação (leia antes)

O mantenedor publicou um **guia oficial de self-host** ("CRM Gratuito — Clone e Modifique"). O caminho vanilla é:

```bash
git clone https://github.com/melgarafael/DeskcommCRM.git
cd DeskcommCRM
bash hostgator-setup-kit/install.sh
```

O `install.sh` é um **wizard idempotente**: pergunta domínio, chaves do Supabase (Session pooler), IA e admin **uma por uma**, aplica o schema no Supabase, sobe todo o stack (Caddy+SSL, app, **waha**, **redis+srh**, scheduler, worker) e conecta o WhatsApp por QR. Roda em ~20–40 min. Dá pra rodar de novo sem estragar nada.

**O detalhe que muda tudo pra quem vai MODIFICAR:** por padrão o compose **puxa a imagem pronta** do mantenedor:

```
image: ${APP_IMAGE:-ghcr.io/melgarafael/deskcommcrm:stable}   # idem worker/scheduler
```

Ou seja, `install.sh` roda o **build DELE**, não o nosso. O overlay de escola **não** estaria nessa imagem. Mas o compose também tem `build:` presente → dá pra **buildar da nossa fonte**. Então a Fase 0 fica assim:

1. **Genérico verde rápido:** rodar `install.sh` com a imagem pronta → valida a plataforma na VPS em minutos (é o "genérico primeiro" no seu jeito mais barato).
2. **Versão modificada:** buildar a imagem do **nosso fork+overlay** (`docker compose build`, ou CI → GHCR) e apontar `APP_IMAGE`/`WORKER_IMAGE`/`SCHEDULER_IMAGE` para ela. É assim que o overlay entra no ar.

> **Licença:** a página é literalmente "Clone e Modifique" — software grátis, self-host, modificar é endossado. (Conferir o `LICENSE` do repo antes de comercializar.)

---

## 1. Fork + clone + overlay

```bash
# 1) Fork pela UI do GitHub (melgarafael/DeskcommCRM -> sua conta), depois:
git clone git@github.com:<voce>/DeskcommCRM.git
cd DeskcommCRM
git remote add upstream https://github.com/melgarafael/DeskcommCRM.git
git fetch upstream

# 2) Branch de integração nossa a partir da main upstream
git checkout -b escola/main upstream/main
```

> ⚠️ **O upstream removeu o vertical de escola.** A `main` de hoje é um CRM comercial genérico — `crm_students`, `settings/escola` e o schema de alunos **não existem mais**. Logo, **todo o domínio de escola (aluno/turma/matrícula/responsável) é overlay nosso**, incluindo as **migrations** que criam essas tabelas. Lado bom: como não disputamos o domínio com o upstream, o rebase fica mais previsível.

**Overlay das customizações de escola** (para rebase barato): concentrar TUDO que é nosso em caminhos previsíveis, evitando editar arquivos do core sempre que der.

- `lib/escola/` → umbilical SGEI (porte de `src/lib/sgei.ts`), idade anos+meses (`idade.ts`), regras de dois-funis, modelo de domínio escolar.
- `supabase/migrations/` (prefixadas, ex. `9xxxx_escola_*`) → **tabelas de aluno/turma/matrícula/responsável** (o upstream não fornece; são nossas). Manter numeração alta/isolada para não colidir com migrations do upstream no rebase.
- `app/api/v1/escola/` → rotas específicas nossas (ex.: reconexão Salomão/SGEI, CRUD de matrícula).
- `overlay/` (ou `docs/escola/`) → docs, seeds e config de escola.
- Onde o core precisar de gancho, preferir **ponto de extensão** (env, hook, config) a patch inline; se patch for inevitável, deixar comentário `// [escola-overlay]` para achar no rebase.

> Correção que serve pra qualquer instalação (não só escola) → mandar **PR ao upstream**, não patch local.

---

## 2. Provisionar infra (staging na VPS do Google)

Usar o **instalador oficial** para o genérico verde (ele já provisiona tudo: schema no Supabase, app, waha, redis+srh, scheduler, Caddy+SSL, admin, QR):

```bash
git clone git@github.com:<voce>/DeskcommCRM.git && cd DeskcommCRM && git checkout escola/main
```

```bash
bash hostgator-setup-kit/install.sh
```

```bash
bash hostgator-setup-kit/healthcheck.sh
```

- **Redis vem no compose** (`redis:7-alpine` + `serverless-redis-http`) — nada de Upstash externo.
- **WAHA vem no compose** (já com `sha512:`+HMAC). A instalação de staging traz o **seu próprio** WAHA — não é preciso montar um 2º à mão.
- Referências no clone: `docs/deploy-selfhost/`, `docs/vendaval-vps-deploy-comandos.md`, `docs/DEPLOY-CHECKLIST.md`.

> ⚠️ **Staging vai em VM DEDICADA — NÃO co-locar com o WAHA de produção.** Verificado em 28/09: a VPS do WAHA de produção é um box de **1 GB** (Debian 13) rodando `waha-waha-1` (healthy há 2 semanas) + `waha-caddy-1` em 80/443, encostado em swap. Instalar o stack ali causaria **OOM** (WAHA pica ~893 MiB; stack pede 2–4 GB) — matando o WAHA que atende o número no ar — e **colisão em 80/443**. Decisão: **VM nova `deskcomm-staging` (e2-medium, 4 GB, São Paulo, 80/443 liberadas)**, que também será o **futuro lar de produção** (o WAHA legado migra pra ela na Fase 7). Em staging, **desligar a stack de voz** (asterisk/wacalls) para poupar RAM.

---

## 3. Configurar `.env.local` (matriz de variáveis)

> **Nunca commitar `.env*`.** Copiar valores do `.env.local` do sistema no ar / dos painéis. Aqui só os **nomes**.

**A maioria é gerada/perguntada pelo `install.sh`** — você fornece domínio, Supabase (URL, anon, service_role, connection string do **Session pooler**), a chave de IA (OpenRouter/Anthropic/OpenAI) e o admin. O instalador **gera sozinho** os segredos internos: `WAHA_API_KEY_SHA512`, `WAHA_HMAC_SECRET`, chaves **pgcrypto** (CPF/OAuth/`AI_KEYS_ENC_KEY`), `INTERNAL_SECRET`. **Redis é interno** (compose) — sem `UPSTASH_*` externo.

**Bloco SGEI — o overlay ADICIONA (não existe no `.env.example` do produto).** Copiar do `.env.local` do sistema no ar:

```dotenv
# --- SGEI (integração read-only; NUNCA escrever) -----------------------------
SGEI_SUPABASE_URL=            # projeto Supabase do SGEI (leitura direta)
SGEI_SUPABASE_SERVICE_KEY=    # service key read-only do SGEI
SGEI_API_KEY=                 # header x-api-key da Edge Function crm-integracao
SGEI_API_URL=                 # opcional; default no código aponta pro endpoint do SGEI
```

**WhatsApp em staging = chip de teste, no WAHA do próprio stack.**
O WAHA vem no compose já configurado (sha512+HMAC). Então **não** montamos WAHA à mão: sobe o stack de staging e **pareia o chip de teste pelo QR** dele (WhatsApp → Aparelhos conectados). O WAHA de produção (do sistema no ar) fica intocado — a isolação é garantida por **project name próprio** do compose (`-p deskcomm-staging`) e por o WAHA do stack ser interno (sem `ports:` no host).
- **Evolution** (`EVOLUTION_*`) fica de fora — papel coberto por WAHA.
- **Nota para a Fase 7 (corte):** o número de produção hoje roda no WAHA legado sem HMAC/SHA512; na virada, ele passa a ser pareado no WAHA do stack DeskcommCRM (que já é o formato certo). Registrar como item da Fase 7.

**Google (agenda):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (a frente de agenda já existe na main).

---

## 4. Migrations + seed de staging

```bash
supabase db reset                 # confirma o schema da main
npx tsx scripts/seed-crm-vivo.ts  # seed de dados de staging (confira o nome no clone)
```

Não migrar dados de produção nesta fase — isso é ETL por vertical, das Fases 1–4.

---

## 5. Gate de CI

```bash
pnpm install
pnpm gov:verify        # typecheck + lint + lint:channels + test:unit
pnpm build
pnpm test:e2e          # Playwright (opcional nesta fase, recomendado)
```

---

## 6. Re-baseline do mapa (contra a main clonada)

Abrir e reclassificar as linhas que ficaram por papel no snapshot:

- [ ] **Domínio de escola** — confirmar que `crm_students`/`settings/escola`/schema de alunos **não existem** na main (o upstream removeu). Se confirmado, o modelo de aluno/turma/matrícula entra como migrations do overlay na Fase 4.
- [ ] **Google Calendar / agenda** — confirmar cobertura (deve estar ✅; checar se as branches `cal/w0…w2` já mergearam na main ou ainda têm coisa pendente).
- [ ] **Convites / ARCA** (🔌) — mapear ao `webhook_lead_captures`; ver o que depende do SGEI.
- [ ] **Disparos** — mapear a `followup-flows`/campanha.
- [ ] **Evolution** — confirmar que o papel de disparos fica 100% no WAHA.
- [ ] **Cobrança/Salomão** — confirmar ausência (esperado) → segue re-apontar pro SGEI.
- [ ] Atualizar o placar em [MAPA-PARIDADE-DESKCOMM.md](./MAPA-PARIDADE-DESKCOMM.md) com o que mudou.

---

## Definition of Done da Fase 0

- [ ] Fork criado; branch `escola/main` a partir de `upstream/main`; `upstream` remoto configurado.
- [ ] Estrutura de overlay (`lib/escola/`, `app/api/v1/escola/`) criada e documentada.
- [ ] Staging no ar (app + worker + scheduler) via Docker; `healthcheck` ok; `/api/v1/health` 200.
- [ ] Supabase novo com migrations da main aplicadas; seed de staging carregado.
- [ ] `.env.local` completo, incluindo o bloco SGEI; segredos fora do git.
- [ ] `pnpm gov:verify` + `pnpm build` verdes.
- [ ] Mapa re-baselineado e commitado.
- [ ] Cadência de rebase da upstream definida (ex.: quinzenal, com CI como gate).

Concluída a Fase 0, seguir para a **Fase 1 — Umbilical SGEI** (portar `src/lib/sgei.ts` para `lib/escola/sgei.ts`, reusando `normalizarCelularBR`, `identificarResponsavel`, `getOcupacaoDireta`, `checkLead`).
