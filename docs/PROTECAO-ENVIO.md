# Proteção de envio (anti-ban do WhatsApp)

Desde 21/10/2026. Inspirado na proteção do DeskcommCRM, adaptado ao escola-crm.
Complementa `docs/POLITICA-ANTI-BLOQUEIO-WHATSAPP.md` (regras operacionais) e `src/lib/pacing.ts`
(teto por execução de cron, que continua valendo).

> **Não garante** que o WhatsApp não bloqueie o número. Reduz padrões locais de risco: rajada,
> volume alto num número novo, cópia repetida, envio para quem pediu para parar. Denúncias,
> bloqueios dos destinatários e falta de opt-in pesam mais que qualquer ritmo.

## Peças
| Peça | Onde |
|---|---|
| Portão único | `src/lib/envio/portao.ts`: `enviarProtegido`, `preChecarEnvio`, `saldoDoDia`, `protegerEnviarTexto` |
| Regras puras (testadas) | `src/lib/envio/regras.ts` + `regras.test.ts`; `portao.test.ts` |
| Defaults | `src/lib/envio/defaults.ts` |
| Config por canal | `crm.canal_protecao` (campo nulo = default) · tela `/configuracoes/protecao-envio` |
| Ledger | `crm.envio_ledger`: uma linha por envio/veto/adiamento. O texto é apagado depois de 30 dias (heartbeat). |
| Reserva atômica | RPC `crm.envio_reservar` (advisory lock por canal) + `crm.envio_confirmar` |
| Trava das filas do Arca | `crm.envio_item_claim` via `envio_item_reivindicar`/`envio_item_concluir` |
| SQL | `docs/sql/2026-10-21-protecao-envio.sql` |

## Ordem dos portões
1. opt-out (`familias.opt_out_em`) → vetado;
2. janela: **disparo** para envios proativos, **resposta** para resposta da IA, nunca para manual → adiado;
3. texto repetido (Jaccard ≥ 0,8 contra as últimas 20 saídas do canal; veta a 3ª cópia). Isentos:
   textos com ≤ 15 caracteres, Pix/boleto/cobrança/link de pagamento → vetado;
4. reserva: teto do dia = mín(aquecimento, `teto_diario`) e intervalo mínimo + jitter → adiado;
5. espera o intervalo → transporte → confirma no ledger.

## Quem barra o quê (modo `ativo`)
| Origem | Barrado por |
|---|---|
| Follow-up, Retomada | tudo |
| Salomão (boletos/comunicados), Convites | tudo **menos repetição**: é campanha, o mesmo texto vai a muitas famílias por desenho |
| Resposta da IA | **só opt-out**. Repetição e intervalo viram registro: silêncio para quem acabou de escrever é pior |
| Manual (tela de conversa) | **nada**. Conta no ledger e devolve avisos |

O teto do dia só barra as origens proativas. Resposta da IA e envio manual entram na contagem.
A Cloud oficial (`banRisk=false`) não tem teto, aquecimento nem gate de repetição locais;
vale janela e opt-out.

## Modos (`PROTECAO_ENVIO_MODO`)
- `off`: passa direto, nada é registrado.
- `log` (**default**): nada é barrado e o ritmo não muda. O ledger registra `vetaria`/`adiado`
  (o que teria barrado) e os envios. Use alguns dias antes de ativar.
- `ativo`: barra conforme a tabela acima.

Falha do próprio portão (banco fora) = **fail-open**: envia e loga.

## Aquecimento
Idade do **número** (não da conexão), declarada em "Número usado desde". Degraus: 0–3 dias 20/dia,
4–7 50, 8–14 100, 15–30 200, 31+ sem teto. Sem data = idade 0. **Antes de pôr em `ativo`,
preencha a data de cada número**, senão o teto vira 20 mensagens proativas por dia.

## Limites conhecidos
- Mídia manual (`/api/mensagens/enviar-midia`) e os recados internos ao gestor (`alertas`,
  `notificacoes`, aviso de transbordo) não passam pelo portão.
- A trava das filas do Arca protege instâncias **deste** app. Outro sistema drenando a mesma
  `disparos_fila` (o deskcomm-staging, ver a memória "cobrança duplicada") não usa a trava e
  precisa ser desligado lá.
- Tentativa incerta (reservada, sem confirmação) conta na cota. É uma postura conservadora.
- Em `log`, uma linha `adiado` significa "teria adiado"; o envio saiu e aparece como `enviado`
  com motivo `sem_reserva:*`.
