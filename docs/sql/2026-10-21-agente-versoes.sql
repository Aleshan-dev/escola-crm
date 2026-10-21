-- Versionamento da configuração da Sara e do Salomão (padrão DeskcommCRM) — 21/10/2026.
-- SGEI, schema crm. Migration: agente_versoes_20261021.
--
-- Fluxo: editar na tela grava RASCUNHO (não toca produção) → testar o rascunho
-- contra um lead real (só gera a resposta, não envia) → PUBLICAR cria vN, arquiva
-- a publicada anterior e reflete o snapshot em crm.config_ia. Quem lê (sara.ts,
-- salomao.ts, ia-credenciais.ts) continua lendo config_ia — nada muda para eles.
-- Rollback = publicar de novo o snapshot de uma versão antiga (vira vN+1).
--
-- O snapshot usa os NOMES DAS COLUNAS de config_ia como chaves. Campos versionados:
--   sara:    nome_agente, modelo, informa_preco, system_prompt, sara_credencial_id
--   salomao: salomao_modelo, salomao_system_prompt, salomao_canais_pagamento, salomao_credencial_id
-- salomao_ativo NÃO é versionado: é kill switch operacional, efeito imediato.
-- Espelho TS: src/lib/agente-versoes/regras.ts (CAMPOS_VERSIONADOS).

create table if not exists crm.agente_versoes (
  id            uuid primary key default gen_random_uuid(),
  agente        text not null check (agente in ('sara','salomao')),
  versao        integer,                                  -- null enquanto rascunho
  snapshot      jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  status        text not null default 'rascunho' check (status in ('rascunho','publicada','arquivada')),
  origem        text not null default 'tela' check (origem in ('tela','maestro','restauracao','baseline')),
  nota          text,
  base_versao   integer,                                  -- de qual versão o rascunho/rollback partiu
  criado_por    text,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  publicado_por text,
  publicado_em  timestamptz,
  check ((status = 'rascunho') = (versao is null)),
  unique (agente, versao)
);
-- No máximo um rascunho e uma publicada por agente.
create unique index if not exists agente_versoes_um_rascunho on crm.agente_versoes (agente) where status = 'rascunho';
create unique index if not exists agente_versoes_uma_publicada on crm.agente_versoes (agente) where status = 'publicada';
alter table crm.agente_versoes enable row level security;
grant select, insert, update, delete on crm.agente_versoes to service_role;

-- Publica atomicamente: o rascunho (p_id) vira vN publicada, a anterior é
-- arquivada e config_ia recebe o snapshot. Com p_snapshot (rollback), cria a
-- versão direto a partir do snapshot informado sem mexer no rascunho existente.
create or replace function crm.publicar_agente_versao(
  p_agente text,
  p_id uuid default null,
  p_snapshot jsonb default null,
  p_por text default null,
  p_nota text default null,
  p_base_versao integer default null
) returns crm.agente_versoes
language plpgsql
security definer
set search_path = crm, public
as $$
declare
  v_snap jsonb;
  v_versao integer;
  v_row crm.agente_versoes;
  r crm.config_ia;
begin
  if p_agente not in ('sara','salomao') then
    raise exception 'agente inválido: %', p_agente;
  end if;

  -- Serializa publicações do mesmo agente.
  perform pg_advisory_xact_lock(hashtext('agente_versoes:' || p_agente));

  if p_snapshot is null then
    select snapshot into v_snap from crm.agente_versoes
      where id = p_id and agente = p_agente and status = 'rascunho' for update;
    if v_snap is null then
      raise exception 'rascunho não encontrado';
    end if;
  else
    v_snap := p_snapshot;
  end if;

  select coalesce(max(versao), 0) + 1 into v_versao from crm.agente_versoes where agente = p_agente;

  update crm.agente_versoes set status = 'arquivada', atualizado_em = now()
    where agente = p_agente and status = 'publicada';

  if p_snapshot is null then
    update crm.agente_versoes
       set status = 'publicada', versao = v_versao, publicado_por = p_por, publicado_em = now(),
           atualizado_em = now(), nota = coalesce(p_nota, nota)
     where id = p_id
     returning * into v_row;
  else
    insert into crm.agente_versoes (agente, versao, snapshot, status, origem, nota, base_versao, criado_por, publicado_por, publicado_em)
    values (p_agente, v_versao, v_snap, 'publicada', 'restauracao', p_nota, p_base_versao, p_por, p_por, now())
    returning * into v_row;
  end if;

  -- Reflete em config_ia (tipagem via jsonb_populate_record). Chave ausente no
  -- snapshot = null na coluna, igual à tela gravando campo vazio.
  r := jsonb_populate_record(null::crm.config_ia, v_snap);
  -- Versão antiga pode apontar para credencial já apagada (FK): cai no padrão.
  if r.sara_credencial_id is not null and not exists (select 1 from crm.ia_credenciais where id = r.sara_credencial_id) then
    r.sara_credencial_id := null;
  end if;
  if r.salomao_credencial_id is not null and not exists (select 1 from crm.ia_credenciais where id = r.salomao_credencial_id) then
    r.salomao_credencial_id := null;
  end if;
  if p_agente = 'sara' then
    update crm.config_ia set
      nome_agente = r.nome_agente, modelo = r.modelo, informa_preco = coalesce(r.informa_preco, false),
      system_prompt = r.system_prompt, sara_credencial_id = r.sara_credencial_id, atualizado_em = now()
    where id = 1;
  else
    update crm.config_ia set
      salomao_modelo = r.salomao_modelo, salomao_system_prompt = r.salomao_system_prompt,
      salomao_canais_pagamento = r.salomao_canais_pagamento, salomao_credencial_id = r.salomao_credencial_id,
      atualizado_em = now()
    where id = 1;
  end if;

  return v_row;
end;
$$;
revoke all on function crm.publicar_agente_versao(text, uuid, jsonb, text, text, integer) from public, anon, authenticated;
grant execute on function crm.publicar_agente_versao(text, uuid, jsonb, text, text, integer) to service_role;

-- Baseline: o que está em produção hoje vira v1 publicada de cada agente.
insert into crm.agente_versoes (agente, versao, snapshot, status, origem, nota, criado_por, publicado_por, publicado_em)
select 'sara', 1,
       jsonb_build_object('nome_agente', nome_agente, 'modelo', modelo, 'informa_preco', informa_preco,
                          'system_prompt', system_prompt, 'sara_credencial_id', sara_credencial_id),
       'publicada', 'baseline', 'Configuração em produção em 21/10/2026', 'migracao', 'migracao', now()
from crm.config_ia where id = 1
and not exists (select 1 from crm.agente_versoes where agente = 'sara');

insert into crm.agente_versoes (agente, versao, snapshot, status, origem, nota, criado_por, publicado_por, publicado_em)
select 'salomao', 1,
       jsonb_build_object('salomao_modelo', salomao_modelo, 'salomao_system_prompt', salomao_system_prompt,
                          'salomao_canais_pagamento', salomao_canais_pagamento, 'salomao_credencial_id', salomao_credencial_id),
       'publicada', 'baseline', 'Configuração em produção em 21/10/2026', 'migracao', 'migracao', now()
from crm.config_ia where id = 1
and not exists (select 1 from crm.agente_versoes where agente = 'salomao');
