# Fase 0 — Esqueleto do overlay + arranque (pronto pra colar)

> **Data:** 2026-09-28 · Companheiro de [CUTOVER-FASE0-RUNBOOK.md](./CUTOVER-FASE0-RUNBOOK.md)
> **Decisão vigente:** genérico primeiro, adaptações por cima. Este esqueleto sobe **junto com o boot** — pastas + convenção + módulos vazios, **sem lógica de escola ainda**. A lógica entra vertical a vertical (Fases 1→5).
> **Como usar:** depois de `git checkout -b escola/main upstream/main` no clone, criar os arquivos abaixo, commitar como "chore(escola): esqueleto do overlay" e seguir a subida do genérico.

---

## Árvore do overlay (o que criar no clone)

```
lib/escola/
  index.ts                     # ponto único de import do overlay
  sgei.ts                      # colar de FASE1-SGEI-OVERLAY.md (Fase 1)
  sgei.test.ts                 # idem
  dominio/                     # modelo de escola (Fase 4) — vazio por ora
    .gitkeep
app/api/v1/escola/
  .gitkeep                     # rotas nossas (Fase 4/5) — vazio por ora
supabase/migrations/
  29990000000000_escola_0000_baseline.sql   # migration-âncora do overlay (sem tabelas ainda)
docs/escola/
  OVERLAY.md                   # convenção do overlay (abaixo)
```

> **Numeração das migrations do overlay:** prefixo alto e namespado `29990000000000_escola_<n>_<slug>.sql`. O `2999…` faz elas **ordenarem sempre depois** das migrations do upstream (evita interleave no rebase), e o `escola_` deixa óbvio o que é nosso. As tabelas de escola (Fase 4) são **independentes** das do core, então a ordem relativa ao upstream não importa — o prefixo alto é só higiene de rebase.

---

## Stub 1 — `lib/escola/index.ts`

```ts
// [escola-overlay] Ponto único de import do overlay de escola.
// Mantém o core "cego" ao overlay: o core chama daqui, não de arquivos soltos.
// Fase 1 liga o SGEI; Fase 4 exporta o modelo de domínio.
export * as sgei from './sgei'
// export * as dominio from './dominio'  // (Fase 4)
```

## Stub 2 — `supabase/migrations/29990000000000_escola_0000_baseline.sql`

```sql
-- [escola-overlay] Migration-âncora do overlay de escola.
-- Proposito: fixar o namespace/numeração das migrations nossas ANTES de existir
-- qualquer tabela. As tabelas de aluno/turma/matricula/responsavel entram na
-- Fase 4, todas com prefixo 29990000000000_escola_*.
-- Nesta baseline: nada de schema ainda (mantem o overlay presente e verde).
-- Convenção confirmada em docs/escola/OVERLAY.md.
select 1;  -- no-op; substituir por schema real a partir da Fase 4
```

## Stub 3 — `docs/escola/OVERLAY.md`

```markdown
# Overlay de escola (customizações sobre o DeskcommCRM genérico)

O upstream (melgarafael/DeskcommCRM) é um CRM comercial genérico e **não tem
domínio de escola**. Tudo que é específico da escola vive aqui, isolado, para o
rebase da upstream ser barato.

## Onde mora o quê
- `lib/escola/`        → lógica (umbilical SGEI, modelo de domínio, dois-funis, idade).
- `app/api/v1/escola/` → rotas nossas (CRUD de matrícula, reconexão Salomão/SGEI).
- `supabase/migrations/29990000000000_escola_*` → tabelas de escola (Fase 4+).
- `docs/escola/`       → docs, seeds e config de escola.

## Regras
1. O core chama o overlay só via `lib/escola/index.ts` (ponto de extensão), nunca
   arquivos soltos. Onde precisar tocar o core, marcar com `// [escola-overlay]`.
2. Migrations nossas usam o prefixo `29990000000000_escola_*` (ordenam depois do
   upstream) e são independentes das tabelas do core.
3. Correção que serve pra qualquer instalação → PR ao upstream, não patch local.
4. Antes de aceitar rebase da upstream: `pnpm gov:verify` + e2e verdes.
```

> `dominio/.gitkeep` e `app/api/v1/escola/.gitkeep` são arquivos vazios só para versionar as pastas.

---

## Folha de arranque — quem faz o quê

**Você (na VPS / no GitHub), ações que dependem dos seus acessos:**
1. Fork de `melgarafael/DeskcommCRM` → sua conta.
2. Na VPS: `git clone …`, `git remote add upstream …`, `git checkout -b escola/main upstream/main`.
3. Criar o esqueleto acima; commitar `chore(escola): esqueleto do overlay`.
4. Provisionar Supabase novo + Upstash Redis + 2º container WAHA isolado (ver [runbook](./CUTOVER-FASE0-RUNBOOK.md) §2–3).
5. `docker compose up -d`; `pnpm install`; `pnpm gov:verify`; `pnpm build`.

**Eu (já pronto pra colar / próximos passos daqui):**
- `lib/escola/sgei.ts` + teste → [FASE1-SGEI-OVERLAY.md](./FASE1-SGEI-OVERLAY.md) (colar na Fase 1).
- Modelo de dados de escola (migrations `alunos`/`turmas`/`matriculas`/`aluno_responsavel`) → posso rascunhar já, pra você ter em mãos quando chegar na Fase 4.
- Mapear os pontos de encaixe (handler inbound, criação de contato/lead) **contra a árvore real** assim que o clone existir.

---

## Definition of Done da Fase 0 (condensado)

- [ ] Fork + `escola/main` a partir de `upstream/main`; remoto `upstream` configurado.
- [ ] Esqueleto do overlay commitado (pastas + `index.ts` + migration-âncora + `OVERLAY.md`).
- [ ] Genérico no ar em staging via Docker; `healthcheck` ok; `/api/v1/health` 200.
- [ ] Supabase novo com migrations da main; Redis ligado; 2º WAHA isolado no ar.
- [ ] `pnpm gov:verify` + `pnpm build` verdes **com o esqueleto** (prova que o overlay vazio não quebra nada).
- [ ] Mapa re-baselineado (confirmar ausência do domínio de escola na main).

Concluída a Fase 0 → **Fase 1**: colar `lib/escola/sgei.ts` e ligar a leitura de responsável no inbound.
