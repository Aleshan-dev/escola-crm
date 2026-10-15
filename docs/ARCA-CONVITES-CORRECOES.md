# Convites de pré-matrícula — retorno do CRM para a equipe do ARCA

**De:** escola-crm · **Data:** 29/07/2026
**Assunto:** lado do CRM concluído; correções e melhorias no ARCA

---

## 1. Resumo

O CRM já consome a fila de convites. O gatilho `dispatch_convites_matricula`
está ramificado, o envio sai pelo Evolution (mesma instância e mesmo número do
Salomão dos boletos) e o resultado volta para o ARCA.

**Uma coisa importante mudou no meio do caminho:** o documento
`CONTRATO-CRM-CONVITES.md` que recebemos pede `SELECT` e `UPDATE` diretos em
`matriculas_convites`. Implementamos assim primeiro. Ao verificar o banco,
encontramos duas RPCs que **não estão no contrato**:

```
convite_reivindicar_lote(p_limite integer)
  -> TABLE(id uuid, celular text, mensagem text, lead_id uuid)

convite_marcar_enviado(p_id uuid, p_sucesso boolean, p_erro text)
  -> json
```

Ambas `SECURITY DEFINER`, ambas com `EXECUTE` para `service_role`, junto com a
coluna `reivindicado_em`, o status `'enviando'` e a CHECK
`matriculas_convites_mensagem_preenchida`.

Isso é melhor que o contrato escrito, e melhor que a nossa primeira
implementação. **Reescrevemos o CRM para usar as RPCs e abandonamos o UPDATE
direto.** A máquina de estados fica inteira com vocês.

**Ação necessária:** atualizar `CONTRATO-CRM-CONVITES.md`. Hoje ele descreve uma
interface obsoleta. Qualquer pessoa que o siga vai escrever o código errado —
foi o que aconteceu conosco. A seção 5 deste documento tem o texto substituto.

---

## 2. O que validamos no banco de vocês

Rodamos o contrato ponta a ponta contra a linha de teste `teste_crm_9b325913`
(depois restaurada para `pendente`, `tentativas = 0`).

| Cenário | Resultado |
| --- | --- |
| `convite_reivindicar_lote(50)` | reivindica 1, marca `enviando`, grava `reivindicado_em`, incrementa `tentativas` |
| Chamada concorrente do mesmo lote | 0 linhas — `for update skip locked` funciona, não há envio duplo |
| `convite_marcar_enviado(id, true)` | `{"ok":true,"status":"enviado"}`, com `enviado_em` preenchido |
| Segunda chamada no mesmo id | `{"ok":true,"ignorado":true,"status":"enviado"}` — idempotente |
| `convite_marcar_enviado(id, false, motivo)` | volta a `pendente` com `erro` preenchido e `tentativas = 1` |
| Privilégios | `service_role` executa as duas; `anon` não executa nenhuma |

O desenho de vocês resolve idempotência, exclusão mútua, circuit breaker
(`tentativas < 3`), retomada de item travado (`enviando` há mais de 5 min) e
mensagem vazia. O CRM não replica nada disso — só envia e responde.

**Não mexam nisto:** o índice `matriculas_convites_fila_idx`
(`status, expira_em` parcial em `pendente`) já cobre a leitura da fila; a CHECK
de mensagem preenchida já está no lugar; os privilégios já estão corretos.

---

## 3. Correções necessárias

### 3.1 (P0) A contagem do gatilho mente para a direção

`salomao-trigger-crm` conta a fila de convites assim:

```ts
.eq("status", "pendente").gt("expira_em", new Date().toISOString())
```

`convite_reivindicar_lote` exige **mais** que isso: `tentativas < 3` e
`coalesce(mensagem,'') <> ''`. E aceita **também** `enviando` travado há mais de
5 minutos, que a contagem ignora.

Consequência prática: um convite que falhou 3 vezes continua `pendente` e
continua sendo contado. A direção vê "1 convite na fila", clica em enviar, o CRM
reivindica 0 itens, e a tela continua mostrando "1 na fila". Para sempre. O
gestor vai concluir que a integração está quebrada quando ela está correta.

Duas definições de "enviável" no mesmo sistema vão divergir sempre. A correção
é ter **uma**:

```sql
create or replace function public.convite_fila_contar()
returns integer
language sql
security definer
set search_path to 'public'
as $$
  select count(*)::int
    from matriculas_convites
   where (status = 'pendente'
          or (status = 'enviando' and reivindicado_em < now() - interval '5 minutes'))
     and expira_em > now()
     and tentativas < 3
     and coalesce(mensagem,'') <> '';
$$;
```

E na Edge Function, trocar o bloco de contagem de convites por
`admin.rpc('convite_fila_contar')`. Se um dia o critério da fila mudar, muda num
lugar só.

### 3.2 (P0) Convite em `falha` não tem volta

Depois da 3ª tentativa o convite vira `falha` e não existe caminho de retorno.
Se o celular foi digitado errado no cadastro, aquela família fica
permanentemente sem convite e ninguém é avisado — a fila simplesmente para de
contá-la.

Precisa de uma ação da direção:

```sql
create or replace function public.convite_reenviar(p_id uuid, p_celular text default null)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare c record;
begin
  select * into c from matriculas_convites where id = p_id for update;
  if not found then
    raise exception 'Convite não encontrado.' using errcode = 'P0002';
  end if;
  if c.status not in ('falha','pendente','enviado') then
    return json_build_object('ok', false, 'erro',
      format('Convite em %s não pode ser reenviado.', c.status));
  end if;

  update matriculas_convites
     set status = 'pendente', tentativas = 0, erro = null,
         enviado_em = null, reivindicado_em = null,
         celular = coalesce(p_celular, celular),
         celular_chave10 = coalesce(
           right(regexp_replace(p_celular, '\D', '', 'g'), 10), celular_chave10)
   where id = p_id;

  return json_build_object('ok', true, 'status', 'pendente');
end $$;
```

O parâmetro `p_celular` é o ponto: quase toda `falha` é número errado, e
reenviar para o mesmo número errado não serve para nada. A tela precisa deixar
corrigir o celular junto do reenvio.

**Verifiquem também se a tela da direção renderiza `falha`.** A CHECK aceita o
estado; se o front não tem um caso para ele, o convite desaparece da interface.

E falta o oposto do reenvio: **não existe caminho para cancelar um convite.** Não
há `convite_cancelar` entre as funções, embora `cancelado` seja um estado válido
na CHECK. Descobrimos isso na prática: para parar um convite de teste que estava
sendo retentado pelo cron, tivemos de dar `UPDATE` direto na tabela — exatamente
o acoplamento que este contrato existe para evitar. Enquanto não houver uma
`convite_cancelar(p_id)`, qualquer convite criado por engano só morre com SQL na
mão.

### 3.3 (P1) Ninguém marca `expirado`

`cron.job` não existe no projeto — `pg_cron` não está instalado. Então nada faz
a transição para `expirado`. Convites vencidos ficam `pendente` para sempre:
saem da fila (o filtro `expira_em` os exclui) mas continuam parecendo
pendentes em qualquer listagem por status.

Escolham um dos dois e nos digam qual:

- **Job agendado:** habilitar `pg_cron` e rodar de hora em hora
  `update matriculas_convites set status='expirado' where status in ('pendente','falha') and expira_em <= now()`.
- **Derivar na leitura:** a UI trata `pendente AND expira_em <= now()` como
  expirado e nunca persiste o estado.

Preferimos o job: estado derivado em tela tende a ser reimplementado errado no
segundo lugar que precisar dele. Mas é decisão de vocês — o CRM não depende
disso, só não queremos que a direção veja "pendente" num convite morto.

### 3.4 (P1) `lead_id` chega sempre nulo

`criar_convite_matricula` recebe `p_lead_id`, mas as duas linhas existentes têm
`lead_id = null`, e a RPC de reivindicação devolve o campo.

Precisamos saber: **esse `lead_id` é o id do lead no CRM ou em outra tabela do
ARCA?**

Se for o do CRM e vocês começarem a preenchê-lo, ganhamos precisão de graça.
Hoje, para registrar o convite na conversa da família, casamos o telefone por
sufixo de 8 dígitos — heurística necessária porque no Acre o WhatsApp entrega o
número sem o 9º dígito, mas dois números podem colidir nos últimos 8. Com
`lead_id` preenchido, o vínculo passa a ser exato.

Não é bloqueio. É a diferença entre "quase sempre certo" e "certo".

### 3.5 (P2) Três representações do mesmo telefone

Na mesma integração temos hoje:

| Origem | Formato | Exemplo |
| --- | --- | --- |
| `boletos_disparo` (via `salomao-atendimento`) | E.164 | `5568999822731` |
| `matriculas_convites.celular` | mascarado | `(68) 99982-2731` |
| `matriculas_convites.celular_chave10` | 10 dígitos, sem o 9 | `6899822731` |

O CRM normaliza e está coberto por teste unitário, então **não há nada urgente
aqui**. Mas boletos e convites chegando em formatos diferentes é uma pegadinha
esperando por quem escrever o próximo consumidor. Sugerimos uma coluna gerada
`celular_e164` na tabela de convites, alinhando com o que os boletos já fazem.

---

## 4. Ajuste de texto no contrato e na tela

O critério de aceite 4 do contrato diz: *"Falha no Evolution grava
`status = 'falha'` com o motivo em `erro`"*. Não é o que a RPC faz — ela devolve
para `pendente` e só vira `falha` na 3ª tentativa.

O comportamento da RPC é melhor. O texto é que está velho. Vale corrigir nos
dois lugares:

- no contrato, para o próximo integrador não escrever teste que falha à toa;
- na tela da direção, que precisa mostrar `tentativas` e `erro` **mesmo com o
  convite em `pendente`** — senão a direção vê "pendente" depois de uma falha
  real e conclui que nada aconteceu.

---

## 5. Contrato atualizado (substituir a seção técnica do original)

> ### Fila de convites — interface oficial
>
> O ARCA não fala com o Evolution: enfileira, avisa, e o CRM envia. O Salomão
> segue sendo o único remetente que as famílias conhecem.
>
> **Aviso.** `salomao-trigger-crm` chama o `CRM_TRIGGER_URL` (único para as duas
> filas) com `{ "event": "dispatch_convites_matricula", "origem": "arca",
> "pendentes": N }`. O corpo não traz dados — só diz que há fila. Corpo sem
> `event` significa boletos.
>
> **Consumo.** O CRM usa exclusivamente estas RPCs, com `service_role`. Não há
> `SELECT` nem `UPDATE` direto em `matriculas_convites`:
>
> | RPC | Papel |
> | --- | --- |
> | `convite_reivindicar_lote(p_limite)` | reivindica até `p_limite` itens enviáveis, marca `enviando`, devolve `id, celular, mensagem, lead_id` |
> | `convite_marcar_enviado(p_id, p_sucesso, p_erro)` | fecha o item: `enviado`, ou volta a `pendente` até a 3ª tentativa, ou `falha` |
>
> A RPC de reivindicação é a dona dos critérios de elegibilidade: validade
> (`expira_em`), teto de tentativas, mensagem não vazia e retomada de item
> travado em `enviando` há mais de 5 min.
>
> **`mensagem` é enviada exatamente como está.** O CRM não monta e não reescreve
> o texto: o link, o prazo e o tom da escola são do ARCA.
>
> **Normalização do telefone é do CRM.** `celular` chega mascarado
> (`(68) 99999-9999`) e é convertido para E.164 antes do Evolution.
>
> **Fronteira de estados.** O CRM só provoca `pendente -> enviando -> enviado |
> pendente | falha`, e sempre através das RPCs. `aberto`, `respondido`,
> `aprovado`, `recusado`, `expirado` e `cancelado` são exclusivos do ARCA.
>
> **Lotes.** O CRM processa 50 por leva, com pacing anti-bloqueio de 1–2 s entre
> envios. O excedente sai na leva seguinte: o CRM varre a fila sozinho a cada
> 20 min, em horário comercial do Acre. Um convite criado sem clique no botão
> **não** fica preso.

---

## 6. Pedidos, em ordem

1. Corrigir a contagem do gatilho (3.1) — é o que vai gerar chamado da direção.
2. Criar `convite_reenviar` e `convite_cancelar`, com os botões correspondentes (3.2).
3. Decidir quem marca `expirado` (3.3).
4. Responder o que é `lead_id` e passar a preenchê-lo (3.4).
5. Atualizar o `CONTRATO-CRM-CONVITES.md` com a seção 5.

---

## 7. Integração validada em produção — 30/07/2026

O CRM está no ar e a cadeia inteira foi confirmada com o botão real da direção,
usando a linha de teste `teste_crm_9b325913`:

| Etapa | Evidência |
| --- | --- |
| Ramificação por `event` | não caiu no fluxo de boletos |
| `convite_reivindicar_lote` | `reivindicado_em` gravado, `tentativas` 0 → 1 |
| Normalização do telefone | Evolution recebeu `5568999990000` a partir de `(68) 99999-0000` |
| Chamada ao Evolution | HTTP 400 com `"exists": false` |
| `convite_marcar_enviado(false, motivo)` | voltou a `pendente` com o motivo em `erro` |
| Fronteira de estados | as linhas em `recusado` seguiram intocadas |
| Alerta ao gestor | notificação entregue no WhatsApp do administrador |

Falta um único passo, e ele depende de vocês: **um convite `pendente` para um
celular real**. O número da linha de teste não existe no WhatsApp, portanto o que
está provado é o caminho de falha, não o de entrega. Criem um convite para um
celular de vocês e avisem — confirmamos o ciclo com a mensagem chegando à
família.
