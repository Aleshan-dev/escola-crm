-- Proteção de envio (anti-ban) — 21/10/2026. Projeto SGEI (zdarztyghsnhbsusizko), schema crm.
-- Ver src/lib/envio/ e docs/PROTECAO-ENVIO.md. Aplicado via Supabase MCP (migration
-- protecao_envio_20261021). Backup anterior: schema crm_bkp_20261021.
--
-- Peças:
--   crm.canal_protecao      → overrides por canal (nulo = default do código, src/lib/envio/defaults.ts)
--   crm.envio_ledger        → 1 linha por tentativa de envio (reserva → enviado/falhou) ou veto/adiamento
--   crm.envio_reservar()    → decisão ATÔMICA por canal (advisory lock): teto do dia + intervalo, e grava a reserva
--   crm.envio_confirmar()   → resultado da reserva
--   crm.envio_item_reivindicar() / crm.envio_item_concluir()
--                           → trava por item das filas do Arca (boletos/disparos), que não têm claim próprio

-- ── Config por canal ─────────────────────────────────────────────────────────
create table if not exists crm.canal_protecao (
  canal              text primary key check (canal in ('waha','evolution','cloud')),
  numero_desde       date,             -- desde quando O NÚMERO é usado (idade p/ aquecimento)
  pular_aquecimento  boolean not null default false,
  janela_resposta_ini smallint check (janela_resposta_ini between 0 and 24),
  janela_resposta_fim smallint check (janela_resposta_fim between 0 and 24),
  janela_disparo_ini  smallint check (janela_disparo_ini between 0 and 24),
  janela_disparo_fim  smallint check (janela_disparo_fim between 0 and 24),
  domingo_disparo    boolean,
  intervalo_min_ms   integer check (intervalo_min_ms between 0 and 120000),
  jitter_max_ms      integer check (jitter_max_ms between 0 and 120000),
  teto_diario        integer check (teto_diario is null or teto_diario >= 0),
  fuso               text,
  atualizado_por     text,
  atualizado_em      timestamptz not null default now()
);
insert into crm.canal_protecao (canal) values ('waha'), ('evolution'), ('cloud')
on conflict (canal) do nothing;
alter table crm.canal_protecao enable row level security;

-- ── Ledger ───────────────────────────────────────────────────────────────────
create table if not exists crm.envio_ledger (
  id           uuid primary key default gen_random_uuid(),
  canal        text not null,
  origem       text not null check (origem in ('resposta_ia','followup','salomao','convite','manual','reengajar')),
  status       text not null check (status in ('reservado','enviado','falhou','adiado','vetado','vetaria')),
  motivo       text,
  lead_id      uuid,
  familia_id   uuid,
  texto_norm   text,      -- texto normalizado (≤500) só p/ o gate de repetição; podado em 30 dias
  texto_hash   text,
  criado_em    timestamptz not null default now(),
  confirmado_em timestamptz
);
create index if not exists envio_ledger_canal_criado on crm.envio_ledger (canal, criado_em desc);
create index if not exists envio_ledger_status_criado on crm.envio_ledger (status, criado_em desc);
alter table crm.envio_ledger enable row level security;

-- ── Reserva atômica ──────────────────────────────────────────────────────────
-- Serializa por canal (advisory lock de transação), conta os envios do dia no fuso,
-- aplica o teto (só quando p_conta_teto) e o intervalo mínimo, e GRAVA a reserva na
-- mesma transação — dois drenadores concorrentes não leem o mesmo saldo.
-- Tentativa incerta (reservado sem confirmação) conta na cota: postura conservadora.
create or replace function crm.envio_reservar(
  p_canal text,
  p_origem text,
  p_teto integer,            -- teto efetivo do dia (já = menor entre aquecimento e teto_diario); null = sem teto
  p_conta_teto boolean,      -- false p/ resposta_ia e manual: entram na contagem, mas não são barrados
  p_intervalo_ms integer,    -- intervalo mínimo desde o último envio do canal (já com jitter)
  p_fuso text,
  p_lead_id uuid default null,
  p_familia_id uuid default null,
  p_texto_norm text default null,
  p_texto_hash text default null,
  p_espera_max_ms integer default 15000
) returns json
language plpgsql security definer set search_path = crm as $$
declare
  v_inicio_dia timestamptz;
  v_usados integer;
  v_ultimo timestamptz;
  v_espera integer := 0;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('crm.envio:' || p_canal));

  v_inicio_dia := (date_trunc('day', now() at time zone p_fuso)) at time zone p_fuso;

  select count(*) into v_usados from envio_ledger
   where canal = p_canal and criado_em >= v_inicio_dia and status in ('reservado','enviado');

  if p_conta_teto and p_teto is not null and v_usados >= p_teto then
    insert into envio_ledger (canal, origem, status, motivo, lead_id, familia_id, texto_hash)
    values (p_canal, p_origem, 'adiado', 'teto_diario', p_lead_id, p_familia_id, p_texto_hash);
    return json_build_object('permitido', false, 'motivo', 'teto_diario', 'usados', v_usados, 'teto', p_teto,
      'proxima_tentativa', v_inicio_dia + interval '1 day');
  end if;

  select max(criado_em) into v_ultimo from envio_ledger
   where canal = p_canal and status in ('reservado','enviado') and criado_em > now() - interval '10 minutes';
  if v_ultimo is not null and p_intervalo_ms > 0 then
    v_espera := greatest(0, p_intervalo_ms - (extract(epoch from (now() - v_ultimo)) * 1000)::int);
  end if;
  if v_espera > p_espera_max_ms then
    insert into envio_ledger (canal, origem, status, motivo, lead_id, familia_id, texto_hash)
    values (p_canal, p_origem, 'adiado', 'intervalo', p_lead_id, p_familia_id, p_texto_hash);
    return json_build_object('permitido', false, 'motivo', 'intervalo', 'esperar_ms', v_espera,
      'proxima_tentativa', now() + make_interval(secs => v_espera / 1000.0));
  end if;

  -- A reserva fica datada no instante em que o envio vai de fato sair (agora + espera),
  -- assim o próximo concorrente calcula o intervalo a partir dela.
  insert into envio_ledger (canal, origem, status, lead_id, familia_id, texto_norm, texto_hash, criado_em)
  values (p_canal, p_origem, 'reservado', p_lead_id, p_familia_id, left(p_texto_norm, 500), p_texto_hash,
          now() + make_interval(secs => v_espera / 1000.0))
  returning id into v_id;

  return json_build_object('permitido', true, 'id', v_id, 'esperar_ms', v_espera,
    'usados', v_usados + 1, 'teto', p_teto);
end $$;

create or replace function crm.envio_confirmar(p_id uuid, p_status text, p_motivo text default null)
returns void language sql security definer set search_path = crm as $$
  update envio_ledger set status = p_status, motivo = coalesce(p_motivo, motivo), confirmado_em = now()
   where id = p_id and status = 'reservado' and p_status in ('enviado','falhou');
$$;

-- ── Trava por item das filas do Arca ─────────────────────────────────────────
-- As filas boletos_disparo / disparos_fila são do Arca e não têm claim-lock. Esta
-- tabela é a trava do lado do CRM: só quem insere a linha envia o item. Uma linha
-- 'enviando' com mais de 15 min é considerada travada e pode ser retomada.
create table if not exists crm.envio_item_claim (
  fila          text not null,
  item_id       text not null,
  status        text not null default 'enviando' check (status in ('enviando','enviado','falhou')),
  reivindicado_em timestamptz not null default now(),
  concluido_em  timestamptz,
  primary key (fila, item_id)
);
alter table crm.envio_item_claim enable row level security;

create or replace function crm.envio_item_reivindicar(p_fila text, p_item_id text)
returns boolean language plpgsql security definer set search_path = crm as $$
declare v_ok boolean;
begin
  insert into envio_item_claim (fila, item_id) values (p_fila, p_item_id)
  on conflict (fila, item_id) do update
     set status = 'enviando', reivindicado_em = now(), concluido_em = null
   where envio_item_claim.status = 'falhou'
      or (envio_item_claim.status = 'enviando' and envio_item_claim.reivindicado_em < now() - interval '15 minutes')
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

create or replace function crm.envio_item_concluir(p_fila text, p_item_id text, p_sucesso boolean)
returns void language sql security definer set search_path = crm as $$
  update envio_item_claim set status = case when p_sucesso then 'enviado' else 'falhou' end, concluido_em = now()
   where fila = p_fila and item_id = p_item_id;
$$;

revoke all on function crm.envio_reservar(text,text,integer,boolean,integer,text,uuid,uuid,text,text,integer) from public, anon, authenticated;
revoke all on function crm.envio_confirmar(uuid,text,text) from public, anon, authenticated;
revoke all on function crm.envio_item_reivindicar(text,text) from public, anon, authenticated;
revoke all on function crm.envio_item_concluir(text,text,boolean) from public, anon, authenticated;
grant execute on function crm.envio_reservar(text,text,integer,boolean,integer,text,uuid,uuid,text,text,integer) to service_role;
grant execute on function crm.envio_confirmar(uuid,text,text) to service_role;
grant execute on function crm.envio_item_reivindicar(text,text) to service_role;
grant execute on function crm.envio_item_concluir(text,text,boolean) to service_role;
grant select, insert, update on crm.canal_protecao, crm.envio_ledger, crm.envio_item_claim to service_role;

-- Saldo do dia (migration protecao_envio_usados_hoje): usado por quem precisa saber
-- QUANTO pode enviar antes de reivindicar uma leva (convites: devolver item ao Arca
-- queima tentativa).
create or replace function crm.envio_usados_hoje(p_canal text, p_fuso text)
returns integer language sql stable security definer set search_path = crm as $$
  select count(*)::int from envio_ledger
   where canal = p_canal and status in ('reservado','enviado')
     and criado_em >= (date_trunc('day', now() at time zone p_fuso)) at time zone p_fuso;
$$;
revoke all on function crm.envio_usados_hoje(text,text) from public, anon, authenticated;
grant execute on function crm.envio_usados_hoje(text,text) to service_role;
