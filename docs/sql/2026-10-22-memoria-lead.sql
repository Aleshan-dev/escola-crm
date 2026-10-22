-- Memória durável do lead (ideia do lead_notes do DeskcommCRM) — 22/10/2026.
-- Projeto SGEI (zdarztyghsnhbsusizko), schema crm. Migration: memoria_lead_20261022.
-- Backup pré-mudança: schema crm_bkp_20261022b (config_ia, única tabela existente alterada
-- além de leads, que só ganha uma coluna nullable).
--
-- Fatos duráveis da família (preferências, restrições, contexto, objeções, o que já
-- foi combinado) que a Sara e o Salomão lembram entre conversas, além da janela de 20
-- mensagens. Convive com crm.anotacoes (diário da equipe), não a substitui.
--
-- Diferenças deliberadas em relação ao DeskcommCRM:
--  - substituir NÃO apaga: a nota antiga é arquivada com substituida_por (histórico);
--  - dedupe por título normalizado (índice único parcial): salvar o mesmo título atualiza;
--  - orçamento checado DENTRO da função, sob advisory lock por lead (sem corrida);
--  - escrita só pelo servidor (service_role); a tela lê/edita pelas rotas /api/leads/[id]/memoria.
-- Espelho TS: src/lib/memoria/regras.ts (limites, normalização, custo de uma nota).

create schema if not exists crm_bkp_20261022b;
create table if not exists crm_bkp_20261022b.config_ia as select * from crm.config_ia;

-- Normalização do título (sem extensão unaccent no projeto: translate é imutável).
create or replace function crm.memoria_norm(p text) returns text
language sql immutable parallel safe
as $$
  select regexp_replace(
    translate(lower(btrim(coalesce(p, ''))),
      'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
    '[^a-z0-9]+', ' ', 'g')
$$;

create table if not exists crm.memoria_lead (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references crm.leads(id) on delete cascade,
  titulo          text not null check (length(btrim(titulo)) between 1 and 140),
  corpo           text not null default '' check (length(corpo) <= 600),
  titulo_norm     text generated always as (btrim(crm.memoria_norm(titulo))) stored,
  origem          text not null check (origem in ('sara','salomao','extracao','equipe')),
  autor_id        uuid,
  arquivada_em    timestamptz,
  substituida_por uuid references crm.memoria_lead(id) on delete set null,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);
create index if not exists memoria_lead_ativas_idx on crm.memoria_lead (lead_id, criado_em) where arquivada_em is null;
create unique index if not exists memoria_lead_titulo_unico on crm.memoria_lead (lead_id, titulo_norm) where arquivada_em is null;
alter table crm.memoria_lead enable row level security;
grant select, insert, update, delete on crm.memoria_lead to service_role;

alter table crm.config_ia
  add column if not exists memoria_ativa boolean not null default true,
  add column if not exists memoria_orcamento_chars integer not null default 2500;
do $$ begin
  alter table crm.config_ia add constraint config_ia_memoria_orcamento_chk
    check (memoria_orcamento_chars between 500 and 8000);
exception when duplicate_object then null; end $$;

-- Cursor da extração automática (heartbeat): mensagens até aqui já foram lidas.
alter table crm.leads add column if not exists memoria_extraida_ate timestamptz;

-- Salva uma nota: arquiva as substituídas (só do mesmo lead), faz upsert pelo título
-- normalizado e confere o orçamento do conjunto ativo. Tudo sob lock do lead.
-- p_nota_id: edição pela equipe de uma nota específica (null = criar/upsert por título).
-- Custo de uma nota = length(titulo) + length(corpo) + 8 (mesma conta de regras.ts).
create or replace function crm.memoria_salvar(
  p_lead_id   uuid,
  p_titulo    text,
  p_corpo     text,
  p_origem    text,
  p_autor_id  uuid default null,
  p_substitui uuid[] default '{}',
  p_orcamento integer default 2500,
  p_nota_id   uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = crm, public
as $$
declare
  v_titulo text := btrim(coalesce(p_titulo, ''));
  v_corpo  text := btrim(coalesce(p_corpo, ''));
  v_norm   text := btrim(crm.memoria_norm(p_titulo));
  v_id     uuid;
  v_total  integer;
begin
  if v_titulo = '' or v_norm = '' then
    return jsonb_build_object('ok', false, 'motivo', 'titulo_vazio');
  end if;

  perform pg_advisory_xact_lock(hashtext('memoria_lead:' || p_lead_id::text));

  if p_nota_id is not null then
    update crm.memoria_lead
       set titulo = v_titulo, corpo = v_corpo, atualizado_em = now(),
           origem = case when p_origem = 'equipe' then 'equipe' else origem end,
           autor_id = coalesce(p_autor_id, autor_id)
     where id = p_nota_id and lead_id = p_lead_id and arquivada_em is null
    returning id into v_id;
    if v_id is null then
      return jsonb_build_object('ok', false, 'motivo', 'nao_encontrada');
    end if;
  else
    -- Mesmo título já ativo: atualiza em vez de duplicar.
    update crm.memoria_lead
       set corpo = v_corpo, titulo = v_titulo, origem = p_origem,
           autor_id = coalesce(p_autor_id, autor_id), atualizado_em = now()
     where lead_id = p_lead_id and titulo_norm = v_norm and arquivada_em is null
    returning id into v_id;
    if v_id is null then
      insert into crm.memoria_lead (lead_id, titulo, corpo, origem, autor_id)
      values (p_lead_id, v_titulo, v_corpo, p_origem, p_autor_id)
      returning id into v_id;
    end if;
  end if;

  -- Substituição não destrutiva: só notas ativas DESTE lead, nunca a própria.
  update crm.memoria_lead
     set arquivada_em = now(), substituida_por = v_id, atualizado_em = now()
   where lead_id = p_lead_id and arquivada_em is null
     and id = any(coalesce(p_substitui, '{}')) and id <> v_id;

  select coalesce(sum(length(titulo) + length(corpo) + 8), 0) into v_total
    from crm.memoria_lead where lead_id = p_lead_id and arquivada_em is null;
  if v_total > p_orcamento then
    raise exception 'memoria_orcamento' using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'total', v_total);
exception
  when raise_exception then
    if sqlerrm = 'memoria_orcamento' then
      return jsonb_build_object('ok', false, 'motivo', 'orcamento');
    end if;
    raise;
end;
$$;
revoke all on function crm.memoria_salvar(uuid, text, text, text, uuid, uuid[], integer, uuid) from public, anon, authenticated;
grant execute on function crm.memoria_salvar(uuid, text, text, text, uuid, uuid[], integer, uuid) to service_role;

-- Migration memoria_leads_pendentes_20261022: fila da extração automática (heartbeat).
-- Lead pendente = tem mensagem fora da janela de 20 (o "corte" é a 21ª mais recente)
-- ainda não lida pelo extrator (corte > memoria_extraida_ate). Mais ativos primeiro.
create or replace function crm.memoria_leads_pendentes(p_limite integer default 5)
returns table (lead_id uuid, corte timestamptz, cursor timestamptz)
language sql stable
security definer
set search_path = crm, public
as $$
  select l.id, c.corte, l.memoria_extraida_ate
    from crm.leads l
    cross join lateral (
      select m.criado_em as corte from crm.mensagens m
       where m.lead_id = l.id
       order by m.criado_em desc
      offset 20 limit 1
    ) c
   where c.corte > coalesce(l.memoria_extraida_ate, '-infinity'::timestamptz)
   order by c.corte desc
   limit greatest(1, least(coalesce(p_limite, 5), 50))
$$;
revoke all on function crm.memoria_leads_pendentes(integer) from public, anon, authenticated;
grant execute on function crm.memoria_leads_pendentes(integer) to service_role;
