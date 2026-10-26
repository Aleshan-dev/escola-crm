-- Roteador estilo Deskcomm (camada de intenção) — 21/10/2026. SGEI, schema crm.
-- Migration: roteador_classificador_20261021. Ver docs/MAESTRO-ROTEADOR.md §Classificador.
--
-- A guarda determinística (vínculo SGEI → Salomão/Sara) continua sendo a regra dura.
-- O classificador só pode: manter o agente da guarda ou encaminhar para HUMANO
-- (intenção com agente 'humano' e confiança ≥ mínimo). Intenção que aponte outro
-- agente de IA é vetada pela guarda e fica registrada como 'vetado_guarda'.

create table if not exists crm.roteador_config (
  id                 smallint primary key default 1 check (id = 1),
  classificador_ligado boolean not null default false,
  credencial_id      uuid references crm.ia_credenciais(id) on delete set null, -- null = a da Sara
  modelo             text,                                                      -- null = gpt-4o-mini
  min_confianca      numeric(3,2) not null default 0.60 check (min_confianca between 0 and 1),
  historico_msgs     smallint not null default 4 check (historico_msgs between 0 and 16),
  atualizado_por     text,
  atualizado_em      timestamptz not null default now()
);
insert into crm.roteador_config (id) values (1) on conflict (id) do nothing;
alter table crm.roteador_config enable row level security;

create table if not exists crm.roteador_intencoes (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null unique check (length(nome) between 2 and 60 and nome <> 'none'),
  descricao  text not null,
  exemplos   text[] not null default '{}' check (coalesce(array_length(exemplos, 1), 0) <= 10),
  agente     text not null check (agente in ('sara','salomao','humano')),
  ativo      boolean not null default true,
  ordem      smallint not null default 0,
  criado_em  timestamptz not null default now()
);
alter table crm.roteador_intencoes enable row level security;

insert into crm.roteador_intencoes (nome, descricao, exemplos, agente, ordem) values
  ('reclamacao', 'A família está reclamando, insatisfeita, irritada ou relatando um problema sério com a escola, um funcionário ou um atendimento.',
   array['Estou muito insatisfeita com o atendimento','Quero falar com a direção, isso é um absurdo','Meu filho voltou machucado e ninguém me avisou'], 'humano', 1),
  ('assunto_sensivel', 'Assunto delicado que exige uma pessoa: saúde, segurança ou bem-estar da criança, bullying, separação/guarda, questão jurídica, pedido de cancelamento ou de dados pessoais (LGPD).',
   array['Meu filho está sofrendo bullying','Quero cancelar a matrícula','Preciso dos dados que vocês têm sobre mim'], 'humano', 2),
  ('pede_humano', 'A pessoa pede explicitamente para falar com um atendente humano, secretaria ou direção.',
   array['Quero falar com uma pessoa','Pode me passar para a secretaria?','Não quero falar com robô'], 'humano', 3),
  ('matricula_e_visita', 'Interesse em conhecer a escola, valores, vagas, séries, horários, agendar ou remarcar visita, matrícula de criança nova.',
   array['Quanto custa a mensalidade?','Tem vaga para o maternal?','Queria agendar uma visita'], 'sara', 10),
  ('financeiro_matriculado', 'Assunto financeiro de família já matriculada: boleto, Pix, segunda via, mensalidade em atraso, comprovante.',
   array['Me manda o boleto de novembro','Já paguei, segue o comprovante','Qual a chave Pix?'], 'salomao', 11)
on conflict (nome) do nothing;

alter table crm.roteador_decisoes
  add column if not exists intencao text,
  add column if not exists confianca numeric(4,3),
  add column if not exists resultado text; -- guarda | classificado | escalado_humano | vetado_guarda | sem_match | baixa_confianca | falha

grant select, insert, update, delete on crm.roteador_config, crm.roteador_intencoes to service_role;
