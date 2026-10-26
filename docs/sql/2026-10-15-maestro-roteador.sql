-- ============================================================================
-- Maestro Guardião + roteador — migration ADITIVA.
-- ⚠️ NÃO aplicada em produção nesta tarefa. Rodar só quando for LIGAR o Maestro
--    (MAESTRO_ATIVO=true): sem ela, o opt-out persistente e o log de decisão
--    degradam em silêncio (o PostgREST devolve erro no resultado, que o código
--    ignora, sem derrubar o atendimento).
-- Compatível para frente e para trás: só adiciona, não altera nada existente.
-- ============================================================================

-- 1. Opt-out persistente por família (gate do Maestro, precedência nº 1).
alter table familias add column if not exists opt_out_em timestamptz;

-- 2. Log de decisão do roteador/Maestro (depuração). Mínimo necessário —
--    sem texto de conversa, sem nome, sem dado de criança (LGPD).
create table if not exists roteador_decisoes (
  id        uuid primary key default gen_random_uuid(),
  lead_id   uuid references leads(id) on delete cascade,
  canal     text,
  rota      text    not null,   -- 'sara' | 'salomao' | 'humano'
  motivo    text    not null,   -- opt_out | force_human | ia_pausada | novo_sara | matriculado_*
  permite   boolean not null,
  criado_em timestamptz not null default now()
);
create index if not exists roteador_decisoes_lead_idx on roteador_decisoes(lead_id);
create index if not exists roteador_decisoes_criado_idx on roteador_decisoes(criado_em desc);

-- RLS: o app escreve pelo service admin client (bypassa RLS). Se expor leitura a
-- usuários autenticados no CRM, espelhar a política de `leads`/`mensagens` antes.
