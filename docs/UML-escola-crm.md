# UML — Escola CRM (Sara)

**Data:** 2026-08-12 · **Escopo:** modelagem visual do sistema como está hoje (as-built).
**Fontes:** `src/lib/types.ts`, `followup-regras.ts`, `sara.ts`, `arca.ts`, rotas em `src/app/api/*`, PRD (`docs/PRD-escola-crm.md`).
**Notação:** UML em Mermaid, organizado na visão **4+1** (lógica, processo, desenvolvimento, física, cenários).

> Renderiza direto no visualizador. A fonte de verdade do schema continua sendo `types.ts` + o banco Supabase; este documento é a leitura visual, não substitui a migration.

---

## 1. Visão de casos de uso (atores e o que fazem)

```mermaid
graph LR
    familia(("👨‍👩‍👧 Família<br/>(lead)"))
    consultora(("💬 Consultora"))
    gestor(("📊 Gestor"))
    financeiro(("💰 Financeiro"))
    sara["🤖 Sara (IA)"]
    salomao["🤖 Salomão (IA)"]

    subgraph CRM["Escola CRM"]
        u1["Iniciar conversa no WhatsApp"]
        u2["Ser atendido / qualificado"]
        u3["Agendar visita"]
        u4["Receber lembrete / reengajamento"]
        u5["Operar Kanban do funil"]
        u6["Assumir conversa (handoff)"]
        u7["Escrever anotação interna"]
        u8["Acompanhar dashboard / metas"]
        u9["Configurar séries/turnos/horários/Sara"]
        u10["Disparar boletos"]
        u11["Auditar decisões da Sara"]
    end

    familia --> u1 --> u2 --> u3
    familia --> u4
    consultora --> u5
    consultora --> u6
    consultora --> u7
    gestor --> u8
    gestor --> u9
    gestor --> u11
    financeiro --> u10

    u2 -. executado por .-> sara
    u4 -. executado por .-> sara
    u10 -. executado por .-> salomao
```

---

## 2. Visão lógica — diagrama de classes (modelo de domínio)

Reflete `src/lib/types.ts` e as tabelas usadas no código. Campos abreviados para legibilidade.

```mermaid
classDiagram
    class Funil {
        +string id
        +string nome
        +bool is_padrao
    }
    class Coluna {
        +string id
        +string funil_id
        +string nome
        +string cor
        +int ordem
        +bool ia_ativa_default
        +int followup_intervalo_horas
        +int followup_max
    }
    class Familia {
        +string id
        +string nome_responsavel
        +string telefone
        +string email
        +string origem
        +string canal
    }
    class Crianca {
        +string id
        +string familia_id
        +string nome
        +int idade
        +string serie_desejada
        +string periodo
    }
    class Lead {
        +string id
        +string familia_id
        +string crianca_id
        +string coluna_id
        +string responsavel_id
        +int score
        +Temperatura temperatura
        +bool ia_ativa
        +int followup_count
        +FollowupStatus followup_status
        +bool arquivado
        +string motivo_perda
        +string proxima_acao
        +datetime entrou_coluna_em
        +CamposCognitivos cog_*
    }
    class Mensagem {
        +string id
        +string lead_id
        +Direcao direcao
        +string conteudo
        +string tipo_midia
        +string url_midia
        +string whatsapp_message_id
        +string status
        +string erro_envio
    }
    class Tarefa {
        +string id
        +string lead_id
        +string responsavel_id
        +datetime data_hora
    }
    class Anotacao {
        +string id
        +string lead_id
        +string autor
        +string texto
    }
    class FollowupLog {
        +string id
        +string lead_id
        +string trigger
        +string status
        +datetime criado_em
    }
    class AcaoSara {
        +string id
        +string lead_id
        +string tipo
        +json payload
    }
    class Usuario {
        +string id
        +string nome
        +string email
    }
    class IntegracaoGoogle {
        +string id
        +string access_token
        +string refresh_token
        +string watch_id
    }

    Funil "1" --> "*" Coluna : contém
    Coluna "1" --> "*" Lead : posiciona
    Familia "1" --> "*" Crianca : possui
    Familia "1" --> "*" Lead : origina
    Lead "*" --> "0..1" Crianca : sobre
    Usuario "1" --> "*" Lead : responsável
    Lead "1" --> "*" Mensagem : histórico
    Lead "1" --> "*" Tarefa : agenda
    Lead "1" --> "*" Anotacao : notas
    Lead "1" --> "*" FollowupLog : disparos
    Lead "1" --> "*" AcaoSara : trilha IA
```

**Enums**

```mermaid
classDiagram
    class Temperatura {
        <<enumeration>>
        frio
        morno
        quente
    }
    class Direcao {
        <<enumeration>>
        in
        out_humano
        out_ia
    }
    class FollowupStatus {
        <<enumeration>>
        ativo
        esgotado
    }
    class Periodo {
        <<enumeration>>
        Parcial
        Estendido
        Integral
    }
```

---

## 3. Visão lógica — máquina de estados do Lead (funil)

Estados = colunas do funil. Transições disparadas por conversa (Sara), ação humana (Kanban) ou cron.

```mermaid
stateDiagram-v2
    [*] --> Capturados : família inicia contato no WhatsApp
    Capturados --> VisitaAgendada : Sara agenda (agendar_visita)
    Capturados --> Repescagem : silêncio após follow-ups
    Capturados --> Perdidos : arquivar / motivo_perda

    VisitaAgendada --> VisitaRealizada : compareceu
    VisitaAgendada --> Repescagem : no-show (2h após horário)
    VisitaAgendada --> VisitaAgendada : confirmação véspera / lembrete dia

    Repescagem --> VisitaAgendada : reagendou
    Repescagem --> Perdidos : esgotou reagendamentos (máx 2)

    VisitaRealizada --> Matriculados : fechou matrícula
    VisitaRealizada --> Repescagem : objeção não resolvida
    VisitaRealizada --> Perdidos : desistiu

    Matriculados --> [*]
    Perdidos --> [*]

    note right of VisitaAgendada
        Coração anti-no-show:
        T+0 confirmação · T-1d véspera · T-3h dia
    end note
    note right of Repescagem
        No-show ≠ perda.
        Resgate acolhedor, nunca cobrança.
    end note
```

**Sub-estado ortogonal — motor de follow-up** (independente da coluna):

```mermaid
stateDiagram-v2
    [*] --> Ativo
    Ativo --> Ativo : disparo (count++, backoff cresce)
    Ativo --> Ativo : família responde (count = 0, reset)
    Ativo --> Esgotado : count >= followup_max
    Esgotado --> Ativo : família responde
    Esgotado --> Perdido : 7 dias de silêncio (DIAS_SILENCIO_PERDIDO)
    Perdido --> [*]
```

---

## 4. Visão de processo — sequência: atendimento inbound (Sara)

```mermaid
sequenceDiagram
    actor F as Família
    participant WA as Evolution API (WhatsApp)
    participant WH as /api/admin/evolution-webhook
    participant DB as Supabase (crm.*)
    participant S as Sara (gpt-4o)
    participant SGEI as SGEI (ocupação)

    F->>WA: mensagem
    WA->>WH: webhook (payload)
    WH->>WH: dedupe (whatsapp_message_id)
    alt mensagem fromMe (humano respondeu)
        WH->>DB: grava out_humano + ia_ativa=false
        Note over WH,DB: Handoff — Sara pausa neste lead
    else mensagem da família
        WH->>DB: upsert familia/crianca/lead + grava (direcao=in)
        WH->>DB: fn_leads_score (trigger recalcula score/temperatura)
        alt lead com ia_ativa=true
            WH->>SGEI: getOcupacaoDireta (vagas)
            WH->>S: contexto (histórico, anotações, base, slots)
            S-->>WH: SaraResposta (JSON)
            WH->>DB: aplica movimentação/agendamento/anotação/análise
            WH->>WA: envia resposta (out_ia)
            WH->>DB: grava mensagem + followup reset
        else transbordo / ia_ativa=false
            WH->>DB: sinaliza para atendimento humano
        end
    end
```

---

## 5. Visão de processo — sequência: cron de follow-up

```mermaid
sequenceDiagram
    participant GH as GitHub Actions (agenda)
    participant CR as /api/cron/followup
    participant R as followup-regras.ts (puro)
    participant P as pacing.ts
    participant DB as Supabase
    participant S as Sara (gpt-4o)
    participant WA as Evolution API

    GH->>CR: dispara (a cada ~20 min)
    CR->>DB: busca leads elegíveis (ativos, não arquivados)
    loop por lead candidato
        CR->>R: dentroHorarioComercial? (8h-20h Acre)
        CR->>R: estaDevido? (backoff = base*(count+1))
        alt elegível e dentro da janela
            CR->>R: triggerPorColuna + promptPorTrigger + anguloPorTentativa
            CR->>S: gera texto contextual (não template)
            S-->>CR: mensagem
            CR->>P: respeita teto (6/rodada) + jitter (0,8-2,0s)
            CR->>WA: envia
            alt envio ok
                CR->>DB: followup_log(enviado) + count++ + ultimo_followup_em
            else número inválido (exists:false)
                CR->>DB: followup_status = esgotado
            else falha de envio
                CR->>DB: followup_log(falhou) — NÃO conta tentativa (idempotência)
            end
        end
    end
```

---

## 6. Visão de processo — sequência: Salomão (disparo de boletos)

```mermaid
sequenceDiagram
    participant ARCA as Arca (edge functions SGEI)
    participant EP as /api/webhooks/arca/dispatch-boletos
    participant BG as after() (background)
    participant WA as Evolution API

    ARCA->>EP: POST (x-api-key)
    EP->>EP: valida chave (tempo constante)
    alt chave inválida
        EP-->>ARCA: 401
    else config faltando (env)
        EP-->>ARCA: 5xx (crm_api_key_missing / evolution_offline)
    else ok
        EP-->>ARCA: 200 (responde já)
        EP->>BG: processa fila em background (maxDuration 300s)
        BG->>ARCA: arcaDisparosPendentes (fila fresca, só 'pendente')
        loop por boleto (pacing 1-2s jitter)
            BG->>WA: evolutionSendMedia (PDF assinado)
            alt enviado
                BG->>ARCA: arcaMarcarEnviado(true)
            else falha por item
                BG->>ARCA: arcaMarcarEnviado(false)
                BG->>BG: registrarAlerta (contexto arca/dispatch-boletos)
            end
        end
    end
```

---

## 7. Visão de desenvolvimento / física — componentes e deployment

```mermaid
graph TB
    subgraph Vercel["☁️ Vercel — Next.js 16 / React 19"]
        UI["UI (App Router)<br/>Kanban · Chat · Início · Config"]
        API["Rotas API<br/>webhooks · crons · admin"]
        LIB["Domínio (src/lib)<br/>sara · followup-regras · pacing<br/>disponibilidade · arca · sgei"]
        UI --> API --> LIB
    end

    subgraph GH["⚙️ GitHub Actions"]
        CRON["Agendadores de cron<br/>(contornam limite Hobby)"]
    end

    subgraph Supabase["🗄️ Supabase (projeto SGEI)"]
        PG[("Postgres — schema crm.*<br/>+ triggers (fn_leads_score)<br/>+ RLS + views")]
        RT["Realtime (chat)"]
        AUTH["Auth"]
    end

    OPENAI["🤖 OpenAI gpt-4o<br/>(Sara)"]
    EVO["📱 Evolution API<br/>(WhatsApp — canal principal)"]
    CLOUD["📱 WhatsApp Cloud API<br/>(oficial — sem paridade)"]
    GCAL["📅 Google Calendar"]
    ARCA["💰 Arca (edge functions SGEI)<br/>fila de boletos"]

    CRON -->|dispara| API
    LIB --> PG
    UI --> RT
    UI --> AUTH
    LIB --> OPENAI
    LIB <-->|webhook + send| EVO
    LIB <-->|webhook + send| CLOUD
    LIB <-->|OAuth + push + watch| GCAL
    ARCA -->|POST dispatch| API
    LIB -->|marcar_enviado| ARCA

    classDef debt stroke-dasharray: 5 5;
    class CLOUD debt;
```

> Linha tracejada = **dívida técnica** conhecida (canal WhatsApp Cloud sem paridade com o Evolution — ver PRD, Bloco C item 9).

---

## 8. Notas de fidelidade

- Nomes de estados na §3 são as colunas reais mapeadas em `followup-regras.ts` (`triggerPorColuna`): Capturados, Visita Agendada, Visita Realizada, Repescagem. "Em Atendimento", "Perdidos" e outras colunas configuráveis vivem em `colunas`/`funis` no banco e podem variar por funil.
- O enum `Periodo` na §2 usa os turnos **reais** (Parcial/Estendido/Integral). O `types.ts` ainda declara `matutino/vespertino/integral` no tipo `Crianca.periodo` — divergência a corrigir (PRD, Bloco A item 3).
- Parâmetros numéricos (8h–20h, teto 6/rodada, jitter 0,8–2,0s, backoff, 7 dias) são os defaults de `followup-regras.ts`/`pacing.ts` e da tabela `colunas`; ajustáveis sem alterar a modelagem.
```
