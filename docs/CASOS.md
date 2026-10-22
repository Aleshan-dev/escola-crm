# Casos

Adaptação da função **Casos** do DeskcommCRM ao escola-crm, feita em 22/10/2026.

## O que é

Às vezes a Sara (captação) ou o Salomão (matriculados) não conseguem resolver um pedido sozinhos. Nesse caso, a IA **abre um Caso** para a equipe e **continua falando com a família**.

A equipe decide o Caso na tela **/casos**, ou respondendo no WhatsApp. São três decisões possíveis:

| Ação | Efeito |
|---|---|
| **Concluir** + resposta | A IA comunica a conclusão à família, com as palavras dela. |
| **Pedir informação** + pergunta | A IA pergunta à família. Quando a família responde, o Caso volta para a equipe e um novo aviso é enviado. |
| **Passar para humano** | Transbordo: a IA é pausada (`ia_ativa=false`, `precisa_atendimento_humano=true`). |

Caso **não é** transbordo. Só "passar para humano" silencia a IA.

## Estados

```
aguardando_equipe ──concluir──▶ concluido
        │  ▲
pedir_info  família respondeu / 48h sem resposta
        ▼  │
aguardando_familia

aguardando_equipe ──escalar──▶ escalado
qualquer aberto  ──opt-out / lead arquivado──▶ cancelado
```

- Há no máximo **1 Caso aberto por lead**. Isso é garantido por um índice único parcial.
- As transições usam a RPC `crm.caso_transicionar`: um update condicionado ao estado esperado, mais o registro do evento. Uma corrida ou um clique repetido devolve **409** e nunca sobrescreve.

## Peças

| Onde | O quê |
|---|---|
| `docs/sql/2026-10-22-casos.sql` | Tabelas `casos`, `caso_eventos`, `caso_chat` e `caso_avisos`; RPCs `caso_abrir` e `caso_transicionar`; flags em `config_ia`. **Já aplicado** no SGEI (`casos_20261022`). |
| `src/lib/casos/regras.ts` | Estados, transições, validação e trechos de prompt. Puro, com testes. |
| `src/lib/casos/servico.ts` | Abrir, agir, atualizar pela família, cancelar, avisar a equipe e executar comandos `#C`. |
| `src/lib/casos/turno.ts` | Efeitos de Caso de um turno de atendimento, incluindo a guarda de promessa. |
| `src/lib/casos/retorno.ts` | Turno de retorno: a IA comunica a decisão da equipe. |
| `src/lib/casos/cobranca.ts` | Cobrança de Casos parados; roda no heartbeat. |
| `src/lib/casos/chat-interno.ts` | Conversa interna da equipe com a IA sobre o Caso. |
| `src/app/casos/page.tsx` + `src/app/api/casos/**` | Tela e rotas da API. |
| `src/app/configuracoes/casos/page.tsx` | Configuração. |

### Como a IA abre um Caso

O escola-crm não usa function calling: os agentes devolvem um JSON. Com `casos_ativo` ligado, o JSON ganha dois campos:

- `abrir_caso: {titulo, resumo, motivo, tipo}`: pede um Caso novo.
- `atualizar_caso: {informacao}`: traz a resposta da família quando a equipe pediu uma informação.

O `contexto` do Caso é montado pelo código a partir das mensagens reais, e não pelo modelo.

A Sara vê no prompt o Caso aberto do lead. Enquanto houver Caso aberto, o gatilho de transbordo por repetição de "vou verificar" não conta.

### Retorno da IA

1. A rota de ação marca `retorno_pendente_em` e chama `after(executarRetornoCaso)`.
2. O retorno reivindica a marca com um update condicional, para que só uma execução envie.
3. Ele gera a resposta com o runtime do agente e envia pelo portão anti-ban, com origem `resposta_ia`.
4. Se o `after()` morrer, o heartbeat refaz o retorno depois de 5 minutos, com até 3 tentativas em caso de falha.
5. Se a IA estiver pausada no lead, o retorno **não fala**. Ele registra o evento `retorno_pulado` e uma anotação na timeline, para quem está atendendo repassar à mão.

### Avisos por WhatsApp

- **Destino:** `config_ia.casos_telefone_aviso`. Se estiver vazio, usa `telefone_transbordo`.
- **Quando:** na abertura, quando a família responde, quando a família fica 48h sem responder, e numa cobrança a cada 24h com o Caso parado em "aguardando equipe" (até 3).
- **Sem duplicata:** o aviso é reivindicado em `caso_avisos` **antes** do envio, com `unique (caso_id, chave)`. Execuções concorrentes não duplicam. A tabela guarda só o hash do texto.
- **Fora do portão anti-ban:** o aviso vai para um número interno, como o `notificarGestor`.
- **Horário:** a cobrança e o reprocessamento de retornos só rodam em horário comercial (`dentroHorarioComercial`).

### Comandos pelo WhatsApp

Só valem com `casos_comandos_whatsapp` ligado e quando a mensagem vem do número de aviso:

```
#C12 ok <resposta para a família>
#C12 pedir <o que perguntar à família>
#C12 humano
```

O comando sai do fluxo normal: não cria família nem roda a IA. Mensagem desse número que não é comando segue o fluxo de sempre.

### Guarda de promessa (`casos_guarda_promessa`)

A guarda age quando a IA promete verificar ou retornar sem abrir um Caso. Os modos são:

- **`log`** (padrão): só registra no log, com a etiqueta `[casos/guarda modo=log]`.
- **`ativo`:**
  - Sara: refaz a resposta uma vez. Se ela insistir na promessa, abre um Caso mínimo com `origem='guarda_promessa'`.
  - Salomão: abre o Caso mínimo direto, sem refazer.

A detecção é léxica, então não pega toda paráfrase. Os testes em `casos.test.ts` mostram o que cobre.

### Outros efeitos

- **Follow-up:** leads com Caso em `aguardando_equipe` ficam **fora do follow-up**, para não haver duas vozes automáticas.
- **Salomão:** o `recado` para a Arca continua igual. `abrir_caso` serve para perguntas cuja resposta volta pela conversa.

## Como ligar

1. Faça o deploy do código.
2. Em **/configuracoes/casos**, defina o número de aviso, clique em "Enviar aviso de teste" e depois marque **Ligar Casos**.
3. Teste de ponta a ponta com um lead de teste:
   1. Faça uma pergunta fora da base. O Caso deve aparecer em /casos e o aviso deve chegar no WhatsApp.
   2. Peça uma informação à família. Quando ela responder, deve chegar um novo aviso.
   3. Conclua o Caso. A IA deve comunicar a conclusão à família.
4. Deixe a guarda de promessa em `log` por 1–2 dias. Confira os logs da Vercel antes de passar para `ativo`.

## Ficou de fora da v1

- Item na aba Alertas.
- Anonimização LGPD dos Casos e retenção do chat interno.
- Papéis: hoje qualquer usuário logado decide um Caso, como no restante do CRM.
