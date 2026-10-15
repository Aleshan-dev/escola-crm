# Plano de merge — CRM vira módulo dentro do ARCA (um projeto Supabase só)

**De:** escola-crm · **Data:** 30/07/2026
**Decisão:** o `sgei` (ARCA) é o projeto que sobrevive. O `escola-crm` é
desmontado para dentro dele, num schema próprio `crm.*`. Vínculo entre os dois
mundos por **FK (bridge) agora, unificação de registro depois**. Nesta rodada:
**banco + repontar o app do CRM**. Fusão de front-ends fica para depois (precisa
do código do ARCA, que não está neste repositório).

---

## 1. Estado atual (medido, não presumido)

| | CRM (`escola-crm` · vdtlfzdedrgqhqrevleu) | ARCA (`sgei` · zdarztyghsnhbsusizko) |
| --- | --- | --- |
| Papel | Topo de funil: leads, WhatsApp, SARA | Sistema-de-registro: alunos, financeiro |
| Região | sa-east-1 | sa-east-1 |
| Tabelas | 31 (todas em `public`) | 24 (em `public`, com enums próprios) |
| Dado sensível | telefone, pouco CPF | **CPF, mensalidades, boletos, PagBank, folha** |
| Núcleo | `leads` → `familias`/`criancas`, `mensagens` (884) | `alunos`/`responsaveis`/`aluno_responsavel`, `mensalidades` |

Ambos em produção. A cadeia de integração foi testada em produção em 30/07/2026.

## 2. A fronteira "limpa" já está furada hoje

O `arca.ts` passa por edge function com `x-api-key` + 2º fator de CPF — o caminho
duro. **Mas** `src/lib/sgei.ts` mantém, no ambiente do CRM, a
`SGEI_SUPABASE_SERVICE_KEY` e lê `responsaveis`, `aluno_responsavel`, `turmas` e a
view `get_ocupacao` **direto**, com service role. Ou seja: o app do CRM já tem
acesso total de leitura ao banco financeiro. O merge **não abre** um acesso que
não exista — ele troca "service key de um projeto guardada no env de outro" por
"mesmo banco, isolado por RLS/role". Bem feito, é uma melhora de postura, não uma
regressão.

Superfície que colapsa em acesso in-DB depois do merge:
- Leitura direta (`sgei.ts`): `responsaveis`, `aluno_responsavel`, `turmas`, `get_ocupacao`.
- Edge functions consumidas: `crm-integracao` (check_lead, ocupacao), `salomao-atendimento` (identificar, financeiro, recado, fila de boletos).
- Fila de convites: RPCs `convite_reivindicar_lote`, `convite_marcar_enviado` (já no sgei).

## 3. Dois problemas que decidem o desenho (novos)

### 3.1 Colisão de identidade sobre o MESMO `auth.users`
O CRM tem `public.usuarios` (papel `admin|coordenador|atendente`, **0 linhas
hoje** — tabela praticamente inerte). O ARCA tem `public.profiles`
(papel `direcao|secretaria|docente|homologacao`) + `funcionarios`. Num projeto só,
os dois apps compartilham **um** `auth.users`. Decisão obrigatória: quem é a fonte
de identidade. Recomendação: **`profiles` do ARCA é a identidade única**; o papel
de operador do CRM vira uma flag/papel dentro desse modelo (ex.: `atendente_crm`),
e `crm.usuarios` é aposentada (0 linhas ⇒ risco de dado zero). Logins humanos hoje
ativos no app do CRM precisam existir no `auth.users` do sgei — é a única parte de
auth que dá trabalho real.

### 3.2 RLS num projeto só (anon key única)
Hoje cada projeto tem a própria anon key. Depois do merge há **uma** anon key e
**um** papel `authenticated` para os dois apps. Isolar o financeiro passa a ser
responsabilidade de **RLS por papel/claim**, não de fronteira de projeto. Regra:
- Tabelas `crm.*`: RLS liberada para operador do CRM autenticado.
- Tabelas financeiras (`mensalidades`, `boletos_disparo`, `pagbank_cobrancas`,
  `cobrancas_avulsas`, `despesas`, `funcionarios`): **escrita só via `service_role`
  / edge function**, leitura negada ao papel do CRM. A trava de CPF do
  `salomao-atendimento` é **preservada** (fica na edge function ou vira RPC
  `SECURITY DEFINER`; o app do CRM nunca lê o financeiro cru).

## 4. Arquitetura alvo

```
projeto sgei (ARCA)
├── public.*        → ARCA: alunos, responsaveis, financeiro, matriculas (intocado)
└── crm.*           → CRM: leads, familias, criancas, mensagens, sara, funis...
     ├── crm.familias.responsavel_id  ─FK→ public.responsaveis(id)   [nullable, preenche na conversão]
     ├── crm.criancas.aluno_id        ─FK→ public.alunos(id)         [nullable]
     └── public.matriculas_convites.lead_id ─FK→ crm.leads(id)       [formaliza o vínculo hoje nulo]
```

- Schema `crm` separado resolve a colisão real: `tarefas` e `turnos` existem dos
  dois lados e são **estruturalmente diferentes** (CRM = tarefa de lead / turno de
  visita; ARCA = tarefa de funcionário / turno de turma).
- Bridge por FK mata o casamento por 8 dígitos (`sgei.ts` linhas 94-104) para
  registros convertidos: onde houver `responsavel_id`/`aluno_id`, o vínculo é
  exato. Os campos denormalizados que o CRM já tem (`familias.sgei_nome`,
  `sgei_vinculo_ativo`, `sgei_checado_em`, `colunas.sgei_turma_id`) viram cache do
  FK, não a fonte.

## 5. Estágios (nada direto na produção do sgei)

0. **Branch do sgei.** Custo confirmado: **US$ 0,01344/hora (~US$ 0,32/dia)**.
   Réplica das migrations do sgei; **sem dados de produção** — serve para validar
   o schema e a cadeia, não os dados.
1. **Schema `crm.*`.** `CREATE SCHEMA crm`; recriar as 31 tabelas sob `crm.*`
   (DDL gerado a partir do banco atual, não à mão). Sem tocar `public`.
2. **Bridge FKs** + índices (`crm.familias.responsavel_id`, `crm.criancas.aluno_id`,
   `public.matriculas_convites.lead_id`).
3. **RLS/grants** conforme §3.2. Rodar `get_advisors(security)` e zerar apontamentos.
4. **Repoint do app CRM.** `NEXT_PUBLIC_SUPABASE_URL`/anon/service → sgei.
   `lib/sgei.ts`: leitura direta vira query in-DB (mesmo banco, sem service key
   cross-project). `lib/arca.ts`: HTTP vira RPC in-DB **mantendo o 2º fator CPF**.
   Remover `SGEI_SUPABASE_*` do env do CRM depois do corte.
5. **Migração de dados cross-project** (corte): copiar as 31 tabelas do escola-crm
   para `crm.*` no sgei preservando UUIDs (PKs são uuid ⇒ sem colisão). Ordem por
   dependência de FK. Reconciliar `familias→responsaveis` e `criancas→alunos` por
   CPF/celular_norm, preenchendo os FKs de bridge onde casar 1-para-1.
6. **Verificação** (contagens por tabela, FKs órfãs, RLS, cadeia SARA/boletos/
   convites de ponta a ponta) → **cutover** → aposentar o projeto `escola-crm`.

## 6. Riscos e rollback
- **Auth**: logins do CRM ausentes no `auth.users` do sgei → planejar antes do §4.
- **RLS**: policy errada expõe financeiro à anon key única → §3.2 é gate, com
  `get_advisors` obrigatório antes do cutover.
- **Corte de dados**: fazer com o app do CRM em janela de baixa; UUIDs preservados
  permitem reimportar; o escola-crm só é aposentado após verificação verde.
- **`config_ia_backup`** (RLS desabilitada no CRM hoje): dropar no §1, não migrar.

## 7. Decisões

**Decididas (30/07/2026):**
1. **Identidade única = `profiles` do ARCA.** `crm.usuarios` (0 linhas) é
   aposentada; operador do CRM vira papel dentro de `profiles`. Logins humanos
   ativos do app CRM precisam ser criados no `auth.users` do sgei antes do §4.
2. Esta rodada = banco + repoint; o app do CRM segue deploy próprio apontando
   pro sgei. Fusão de front-ends depois.

**Em espera:** execução dos §0-3 aguardando revisão deste plano pelo gestor
antes de criar a branch.
