-- Casos: fila de retaguarda aberta pela Sara/Salomão (padrão DeskcommCRM) — 22/10/2026.
-- Projeto SGEI (zdarztyghsnhbsusizko), schema crm. Migration: casos_20261022.
-- Backup pré-mudança: schema crm_bkp_20261022 (config_ia, única tabela alterada).
--
-- Um Caso NÃO é transbordo: a IA continua falando com a família enquanto a equipe
-- decide (concluir / pedir informação / passar para humano). Só "escalar" silencia
-- a IA. Estados abertos: aguardando_equipe, aguardando_familia. Terminais:
-- concluido, escalado, cancelado. No máximo 1 Caso aberto por lead.
--
-- Escrita só pelo servidor (service_role); a tela lê pelas rotas /api/casos.
-- Espelho TS: src/lib/casos/regras.ts (estados, transições, tipos).

create schema if not exists crm_bkp_20261022;
create table if not exists crm_bkp_20261022.config_ia as select * from crm.config_ia;

create table if not exists crm.casos (
  id                  uuid primary key default gen_random_uuid(),
  numero              bigint generated always as identity unique,   -- código curto #C<numero>
  lead_id             uuid not null references crm.leads(id) on delete cascade,
  familia_id          uuid references crm.familias(id) on delete set null,
  agente              text not null check (agente in ('sara','salomao')),
  titulo              text not null check (length(titulo) between 1 and 200),
  resumo              text not null check (length(resumo) <= 4000),
  motivo_bloqueio     text check (length(motivo_bloqueio) <= 4000),
  tipo                text not null default 'outro',
  contexto            text,                                  -- últimas mensagens, montadas pelo código
  origem              text not null default 'agente' check (origem in ('agente','guarda_promessa','manual')),
  estado              text not null default 'aguardando_equipe'
                        check (estado in ('aguardando_equipe','aguardando_familia','concluido','escalado','cancelado')),
  nota_equipe         text check (length(nota_equipe) <= 4000),
  cobrancas           integer not null default 0,
  retorno_pendente_em timestamptz,                           -- turno de retorno da IA ainda não executado
  criado_em           timestamptz not null default now(),
  atualizado_em       timestamptz not null default now(),
  fechado_em          timestamptz,
  fechado_por         text
);
create unique index if not exists casos_um_aberto_por_lead on crm.casos (lead_id)
  where estado in ('aguardando_equipe','aguardando_familia');
create index if not exists casos_estado_idx on crm.casos (estado, atualizado_em);
alter table crm.casos enable row level security;
grant select, insert, update, delete on crm.casos to service_role;

create table if not exists crm.caso_eventos (
  id        uuid primary key default gen_random_uuid(),
  caso_id   uuid not null references crm.casos(id) on delete cascade,
  tipo      text not null,
  ator      text not null,          -- sara | salomao | sistema | whatsapp | equipe:<usuario_id>
  detalhe   jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now()
);
create index if not exists caso_eventos_caso_idx on crm.caso_eventos (caso_id, criado_em);
alter table crm.caso_eventos enable row level security;
grant select, insert, update, delete on crm.caso_eventos to service_role;

-- Conversa interna equipe ↔ IA sobre o Caso. Nunca vai para a família.
create table if not exists crm.caso_chat (
  id         uuid primary key default gen_random_uuid(),
  caso_id    uuid not null references crm.casos(id) on delete cascade,
  papel      text not null check (papel in ('user','assistant')),
  conteudo   text not null,
  usuario_id text,
  turn_id    text not null,
  criado_em  timestamptz not null default now(),
  unique (turn_id, papel)            -- clique duplo / retry não gera segunda chamada paga
);
create index if not exists caso_chat_caso_idx on crm.caso_chat (caso_id, criado_em);
alter table crm.caso_chat enable row level security;
grant select, insert, update, delete on crm.caso_chat to service_role;

-- Avisos por WhatsApp à equipe. A linha é reivindicada (insert) ANTES do envio:
-- o unique (caso_id, chave) impede aviso duplicado em execuções concorrentes.
-- Não guarda o texto, só o hash.
create table if not exists crm.caso_avisos (
  id                uuid primary key default gen_random_uuid(),
  caso_id           uuid not null references crm.casos(id) on delete cascade,
  chave             text not null,   -- abertura | cobranca:<n> | familia:<evento_id> | teste
  tipo              text not null check (tipo in ('abertura','cobranca','familia_respondeu','familia_sem_resposta','teste')),
  destino_mascarado text,
  corpo_hash        text,
  status            text not null default 'pendente' check (status in ('pendente','enviado','falhou')),
  tentativas        integer not null default 0,
  wid               text,
  erro              text,
  criado_em         timestamptz not null default now(),
  enviado_em        timestamptz,
  unique (caso_id, chave)
);
alter table crm.caso_avisos enable row level security;
grant select, insert, update, delete on crm.caso_avisos to service_role;

alter table crm.config_ia
  add column if not exists casos_ativo boolean not null default false,
  add column if not exists casos_telefone_aviso text,
  add column if not exists casos_comandos_whatsapp boolean not null default false,
  add column if not exists casos_guarda_promessa text not null default 'log';
do $$ begin
  alter table crm.config_ia add constraint config_ia_casos_guarda_chk
    check (casos_guarda_promessa in ('off','log','ativo'));
exception when duplicate_object then null; end $$;

-- Abre um Caso + evento 'aberto' atomicamente. Devolve null se o lead já tem um aberto.
create or replace function crm.caso_abrir(
  p_lead_id uuid,
  p_familia_id uuid,
  p_agente text,
  p_titulo text,
  p_resumo text,
  p_motivo text,
  p_tipo text,
  p_contexto text,
  p_origem text
) returns crm.casos
language plpgsql
security definer
set search_path = crm, public
as $$
declare
  v_row crm.casos;
begin
  insert into crm.casos (lead_id, familia_id, agente, titulo, resumo, motivo_bloqueio, tipo, contexto, origem)
  values (p_lead_id, p_familia_id, p_agente, p_titulo, p_resumo, p_motivo, coalesce(p_tipo, 'outro'), p_contexto, coalesce(p_origem, 'agente'))
  on conflict (lead_id) where estado in ('aguardando_equipe','aguardando_familia') do nothing
  returning * into v_row;

  if v_row.id is null then
    return null;
  end if;

  insert into crm.caso_eventos (caso_id, tipo, ator, detalhe)
  values (v_row.id, 'aberto', p_agente, jsonb_build_object('origem', v_row.origem, 'tipo', v_row.tipo));
  return v_row;
end;
$$;
revoke all on function crm.caso_abrir(uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function crm.caso_abrir(uuid, uuid, text, text, text, text, text, text, text) to service_role;

-- Transição condicionada ao estado esperado + evento, numa instrução só. Devolve
-- null se o Caso não estava em nenhum de p_de (corrida/ação repetida = conflito).
create or replace function crm.caso_transicionar(
  p_caso_id uuid,
  p_de text[],
  p_para text,
  p_evento text,
  p_ator text,
  p_nota text default null,
  p_retorno boolean default false,
  p_detalhe jsonb default '{}'::jsonb
) returns crm.casos
language plpgsql
security definer
set search_path = crm, public
as $$
declare
  v_row crm.casos;
  v_terminal boolean := p_para in ('concluido','escalado','cancelado');
begin
  update crm.casos set
    estado = p_para,
    nota_equipe = coalesce(p_nota, nota_equipe),
    retorno_pendente_em = case when p_retorno then now() else retorno_pendente_em end,
    cobrancas = case when p_para = 'aguardando_equipe' then 0 else cobrancas end,
    atualizado_em = now(),
    fechado_em = case when v_terminal then now() else null end,
    fechado_por = case when v_terminal then p_ator else null end
  where id = p_caso_id and estado = any(p_de)
  returning * into v_row;

  if v_row.id is null then
    return null;
  end if;

  insert into crm.caso_eventos (caso_id, tipo, ator, detalhe)
  values (v_row.id, p_evento, p_ator,
          coalesce(p_detalhe, '{}'::jsonb) || case when p_nota is null then '{}'::jsonb else jsonb_build_object('nota', p_nota) end);
  return v_row;
end;
$$;
revoke all on function crm.caso_transicionar(uuid, text[], text, text, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function crm.caso_transicionar(uuid, text[], text, text, text, text, boolean, jsonb) to service_role;
