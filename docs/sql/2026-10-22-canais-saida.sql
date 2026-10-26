-- Canais de saída — carimbo de canal, idempotência de envio e trilha de webhooks.
-- Ver docs/CANAIS-DE-SAIDA.md. Tudo aditivo: colunas nullable e tabelas novas.

-- 1. Canal físico em cada mensagem (entrada e saída). Antigas ficam NULL.
alter table crm.mensagens
  add column if not exists canal_whatsapp text,
  add column if not exists canal_ref text;

do $$ begin
  alter table crm.mensagens add constraint mensagens_canal_whatsapp_check
    check (canal_whatsapp is null or canal_whatsapp in ('waha', 'cloud', 'evolution'));
exception when duplicate_object then null; end $$;

comment on column crm.mensagens.canal_whatsapp is 'Canal físico por onde a mensagem entrou/saiu (waha|cloud|evolution). NULL = anterior a 22/10/2026.';
comment on column crm.mensagens.canal_ref is 'Referência da conexão no provedor: sessão WAHA, phone_number_id da Cloud ou instância Evolution.';

-- 2. Origem nova no ledger do portão: avisos internos à equipe (Casos, gestor, alertas).
alter table crm.envio_ledger drop constraint if exists envio_ledger_origem_check;
alter table crm.envio_ledger add constraint envio_ledger_origem_check
  check (origem in ('resposta_ia', 'followup', 'salomao', 'convite', 'manual', 'reengajar', 'aviso_interno'));

-- 3. Idempotência por envio LÓGICO (não por texto): a mesma chave nunca sai duas vezes.
create table if not exists crm.envio_idempotencia (
  chave        text primary key,
  operacao     text not null,
  canal        text,
  status       text not null default 'pendente' check (status in ('pendente', 'enviado', 'falhou')),
  wid          text,
  erro         text,
  criado_em    timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table crm.envio_idempotencia enable row level security;
grant select, insert, update, delete on crm.envio_idempotencia to service_role;

-- 4. Trilha bruta dos webhooks de entrada: recebido → ingerido/duplicado/descartado/rejeitado.
create table if not exists crm.webhook_eventos (
  id          bigserial primary key,
  canal       text not null,
  canal_ref   text,
  evento      text,
  external_id text,
  resultado   text not null check (resultado in ('ingerido', 'duplicado', 'descartado', 'rejeitado', 'erro')),
  detalhe     text,
  payload     jsonb,
  criado_em   timestamptz not null default now()
);
create index if not exists webhook_eventos_criado on crm.webhook_eventos (criado_em desc);
create index if not exists webhook_eventos_canal_resultado on crm.webhook_eventos (canal, resultado, criado_em desc);
alter table crm.webhook_eventos enable row level security;
grant select, insert, update, delete on crm.webhook_eventos to service_role;
grant usage, select on sequence crm.webhook_eventos_id_seq to service_role;

-- 5. Retenção: 30 dias para a trilha e para as chaves de idempotência.
select cron.schedule(
  'canais-retencao-diaria',
  '30 7 * * *',
  $$
    delete from crm.webhook_eventos where criado_em < now() - interval '30 days';
    delete from crm.envio_idempotencia where criado_em < now() - interval '30 days';
  $$
);
