# Memória durável do lead

A memória guarda fatos duráveis de cada família: preferências, restrições, contexto, objeções e combinados. Tanto a Sara quanto o Salomão leem essas notas e gravam novas, entre uma conversa e outra. O objetivo é lembrar o que já saiu da janela das 20 últimas mensagens.

A ideia vem do `lead_notes` do DeskcommCRM, conforme a engenharia reversa de 22/10/2026. A memória **convive** com `crm.anotacoes`, que continua sendo o diário livre da equipe e o lugar do `resumo_anotacao` que a Sara grava a cada turno.

## Como funciona

- **Tabela** `crm.memoria_lead`: cada nota tem título (até 140 caracteres), corpo (até 600) e origem (`sara`, `salomao`, `extracao` ou `equipe`). A nota fica ativa até ser arquivada (`arquivada_em`); quando outra a substitui, `substituida_por` aponta para a nova. O SQL está em `docs/sql/2026-10-22-memoria-lead.sql`.
- **Escrita** só pela RPC `crm.memoria_salvar`. Ela faz quatro coisas:
  - trava o lead com um advisory lock;
  - deduplica pelo título normalizado (salvar o mesmo título atualiza a nota);
  - em `substitui`, arquiva as notas antigas em vez de apagar, e só se forem do mesmo lead;
  - confere o orçamento (`config_ia.memoria_orcamento_chars`, padrão 2500): se a soma de título + corpo + 8 por nota passar do limite, a escrita é recusada.
- **Prompt**: as notas entram como `[M1] título: corpo (data)`, com título e corpo. O corpo vai junto porque não há function calling para buscá-lo sob demanda. O modelo nunca vê uuid; o mapa de M1, M2… para uuid fica no servidor.
- **Gravação no turno**: o campo JSON `memoria_salvar: [{titulo, corpo, substitui}]` aceita no máximo 3 notas por turno. É aplicado pelo `aplicarMemoriaDoTurno`, que nunca derruba o atendimento. Quem grava:
  - o atendimento real, em `atendimento.ts` e `api/sara/responder`;
  - o Salomão, em `processarMensagemSalomao`.

  Preview, teste de rascunho, follow-up e retorno de Caso só leem.
- **Barreira em código**: `validarNota` recusa CPF completo, número de cartão e PIX copia e cola. O prompt do Salomão também proíbe gravar valores e dívidas.
- **Extração automática**: o heartbeat roda `extrairMemoriasPendentes` com até 5 leads e 25s por rodada. A fila sai de `crm.memoria_leads_pendentes`, que devolve os leads com mensagens fora da janela de 20 ainda não lidas.
  - O extrator recebe o trecho antigo da conversa mais a memória atual e grava as notas com origem `extracao`.
  - O cursor `leads.memoria_extraida_ate` avança mesmo quando a saída do modelo é inválida, para não pagar a mesma chamada em loop.
- **Tela**:
  - a seção "Memória da IA" (`src/components/MemoriaLead.tsx`) aparece no modal do lead e na página do responsável; ali a equipe adiciona, corrige, arquiva e vê as arquivadas;
  - a configuração fica em `/configuracoes/memoria` (liga/desliga e orçamento);
  - as rotas são `api/leads/[id]/memoria` e `api/leads/[id]/memoria/[notaId]`.

## O que fizemos diferente do DeskcommCRM

| Lacuna lá | Aqui |
|---|---|
| Duplicatas | Índice único parcial por título normalizado; mesmo título = atualiza |
| `supersedes` apaga | Arquiva com `substituida_por` (histórico visível na tela) |
| Cap checado fora de lock | Checado dentro da RPC, sob advisory lock por lead |
| Preview lê mais que produção | Todos os caminhos usam o mesmo bloco; preview não grava |
| Sem edição manual | A equipe edita e arquiva pela ficha |
| RLS `FOR ALL` para autenticado | Sem policy: só `service_role`; a tela usa as rotas da API |

Ficou de fora por enquanto:
- busca semântica e embeddings (o DeskcommCRM também não usa);
- expiração por idade.
