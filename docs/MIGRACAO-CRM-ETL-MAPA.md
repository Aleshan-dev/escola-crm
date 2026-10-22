# Migração de dados — schema `crm` (SGEI) → DeskcommCRM (staging)

> **Data:** 2026-09-28 · Para aprovação ANTES de qualquer escrita.
> **Origem:** SGEI `zdarztyghsnhbsusizko`, schema `crm` (produção, read-only).
> **Destino:** staging `vdtlfzdedrgqhqrevleu`, schema `public` (DeskcommCRM).
> **Org de destino:** `85191f79-fe25-4683-9590-5d86f4ba91d3` ("Pequenos Guardiões") — TODA linha recebe `organization_id` = esta.
> **Decisões travadas:** dados **reais** (sem anonimizar), mas **endurecer antes** (trocar senha admin + fechar RLS); **aprovar este mapa antes de rodar**.

## Pré-requisitos (endurecer antes de rodar)
- [ ] Trocar a senha do admin `aleshan87@gmail.com` (hoje `12345678`).
- [ ] Resolver RLS: `public.config_ia_backup` (destino) sem RLS — dropar (lixo do schema velho) ou ligar RLS.
- [ ] Confirmar que o staging não está exposto além do necessário (é PII de crianças).

## Ordem de carga (respeita as FKs)
1. `crm.funis` → `crm_pipelines`
2. `crm.colunas` → `crm_stages`
3. `crm.familias` → `contacts` (+ CPF encriptado)
4. `crm.criancas` → `crm_students`
5. `crm.leads` → `crm_leads`
6. `crm.whatsapp_contas` → `channel_sessions` (1 sessão)
7. `crm.mensagens` → `conversations` (1 por lead) + `messages`

Cada passo guarda um **id-map** (id antigo → uuid novo) em memória pra remapear as FKs. Idempotência: gravar o id de origem em `source_metadata.legacy_id` (e `external_id` nas mensagens) pra permitir re-run sem duplicar.

---

## 1. `funis` (2) → `crm_pipelines`
| crm.funis | → crm_pipelines | Nota |
|---|---|---|
| id | (novo uuid; id-map) | |
| — | organization_id | a org |
| nome | name | |
| — | slug | slugify(nome) |
| descricao | description | |
| is_padrao | is_default | |
| criado_em | created_at | |
| — | is_archived=false, position=ordem, vocabulary={}, settings={} | defaults |

## 2. `colunas` (14) → `crm_stages`
| crm.colunas | → crm_stages | Nota |
|---|---|---|
| id | (novo uuid; id-map) | |
| funil_id | pipeline_id | id-map do funil |
| nome | name | |
| — | slug | slugify(nome) |
| cor | color | |
| ordem | position | |
| — | is_won | true se nome ~ "matricul"/"ganho" |
| — | is_lost | true se nome ~ "perdido" |
| ia_ativa_default, followup_intervalo_horas, followup_max, sgei_turma_id | → settings/custom (jsonb) | config escola sem casa no modelo; preservar em `crm_stages` não tem jsonb → guardar no pipeline.settings por stage, OU aceitar perda (é reconfigurável). **Decisão a confirmar.** |
| — | organization_id, is_archived=false, requires_human=false | |

## 3. `familias` (104) → `contacts`
| crm.familias | → contacts | Nota |
|---|---|---|
| id | (novo uuid; id-map) | |
| — | organization_id | a org |
| nome_responsavel | name, display_name | |
| email | email, email_normalized=lower | |
| telefone_norm (ou telefone) | phone_number | usar normalizado |
| **cpf** | **cpf_encrypted (bytea) + cpf_hash** | **encriptar com a lib do app** (AES-256-GCM, `CPF_ENCRYPTION_KEY`) — o ETL importa a função de cripto do próprio repo pra ficar idêntico |
| criado_em / atualizado_em | created_at / updated_at | |
| origem/canal/campanha/referral | source, source_metadata (jsonb) | |
| rg, tipo_responsavel, cep/rua/numero/complemento/bairro/cidade/estado/pais, ja_responsavel, sgei_nome, sgei_vinculo_ativo, sgei_checado_em, whatsapp_phone_number_id, canal_whatsapp | custom_fields (jsonb) | tudo que não tem coluna dedicada |
| — | consent={} , tags=[], is_blocked=false, is_anonymized=false, force_human=false | defaults NOT NULL |

## 4. `criancas` (49) → `crm_students`
| crm.criancas | → crm_students | Nota |
|---|---|---|
| id | (novo uuid; id-map) | |
| familia_id | contact_id | id-map família→contact (**obrigatório**) |
| nome | name | |
| data_nascimento | birthdate | |
| serie_desejada | grade_desired | |
| periodo | shift | |
| — | status | 'lead' (ou 'ativo' se matriculado) — **confirmar regra** |
| motivo_busca | notes | |
| idade, idade_meses, aluno_id (link SGEI) | custom_fields (jsonb) | |
| — | organization_id | a org |

## 5. `leads` (105) → `crm_leads`
| crm.leads | → crm_leads | Nota |
|---|---|---|
| id | (novo uuid; id-map) | |
| coluna_id | stage_id (+ pipeline_id derivado do funil da coluna) | id-maps |
| familia_id | contact_id | id-map |
| crianca_id | student_id | id-map |
| — | title | nome_responsavel (fallback "Lead") |
| arquivado / motivo_perda / convertido_em | status ('open'/'won'/'lost') + lost_reason + closed_at | **mapa de status a confirmar** |
| ultima_interacao_em | last_activity_at | |
| criado_em / atualizado_em | created_at / updated_at | |
| responsavel_id | owner_user_id | id-map usuário (se migrarmos usuarios) |
| canal/origem | source, source_metadata | |
| **todo o resto** (score, temperatura, ia_ativa, tags, cog_*, followup_*, salomao_*, visita_*, no_show_*, sugestao_*, precisa_template*, risco_no_show, etc.) | **custom_fields (jsonb)** | ~40 campos escola/cognitivos sem casa no modelo genérico; preservados em jsonb |
| — | organization_id, pipeline_id, position_in_stage, source, source_metadata, custom_fields, tags | NOT NULL |

## 6. `whatsapp_contas` (4) → `channel_sessions`
`conversations` e `messages` exigem `channel_session_id NOT NULL`. Criar **1 channel_session** (ou por conta) representando o número. Campos de `channel_sessions` a preencher com defaults sãos (status, provider, phone). **Detalhe a fechar ao implementar** (ler colunas de `channel_sessions`).

## 7. `mensagens` (2894) → `conversations` + `messages`
- **conversations:** 1 por lead com histórico → contact_id (via lead→família), channel_session_id, channel='whatsapp', status, last_message_at=max(criado_em), metadata, created_at.
- **messages:**
| crm.mensagens | → messages | Nota |
|---|---|---|
| id | (novo uuid) | |
| lead_id | conversation_id + contact_id | via id-maps |
| direcao | direction ('inbound'/'outbound') | mapear valores |
| conteudo | body | |
| tipo_midia | type ('text'/'image'/'audio'/…) + media_mime | mapear |
| url_midia | media_url | |
| whatsapp_message_id | external_id | idempotência |
| criado_em | sent_at, created_at | |
| status | status | mapear enum |
| agente/agente_origem/enviado_por/lida/erro_envio | metadata (jsonb) + sent_via | |
| — | organization_id, channel_session_id, sent_via | NOT NULL |

---

## Pontos que preciso confirmar com você
1. **Status dos leads/alunos:** como classificar 'won/lost/open' a partir de `arquivado`/`motivo_perda`/`convertido_em`? E aluno 'lead' vs 'ativo'?
2. **Config de coluna (followup/turma):** preservar em jsonb ou aceitar perda (reconfigura na tela)?
3. **Usuários:** migrar `crm.usuarios` (5) como membros da org? (necessário se quisermos `owner_user_id` real; senão fica nulo.)
4. **Tabelas fora do núcleo:** `anotacoes`(273)→`lead_notes`/`conversation_notes`; `eventos_timeline`(907), `acoes_sara`(275), `followup_log`(203), `alertas_sistema`(1073), `base_conhecimento`(21), `auditorias_sara`, `sugestoes_auditoria` — migrar agora ou numa 2ª leva? (Recomendo núcleo primeiro, validar, depois o resto.)

## Validação (após rodar)
Comparar contagens origem↔destino por entidade; amostrar 3-5 famílias e conferir nome/telefone/CPF (decriptar) e vínculo criança↔responsável↔lead↔mensagens.

## Execução
Script node/tsx no repo do clone, lendo do SGEI (service key read-only) e escrevendo no staging via service role, reusando a **função de cripto de CPF do próprio app**. Idempotente por `legacy_id`. Roda por vertical, na ordem acima, com log de contagem.
