/**
 * Diretrizes do Maestro Guardião injetadas no system prompt dos agentes
 * (Sara e Salomão). Fonte ÚNICA do "contrato" que alinha o que o agente escreve
 * com o que o portão de validação (`validar-resposta.ts`) e a política
 * (`politica.ts`) cobram. Fica em código (versionado, reversível, sobe no deploy),
 * não no `config_ia` do banco vivo.
 *
 * Mantém-se curto e ADITIVO: reforça regras que os prompts já têm, sem reescrevê-los.
 *
 * BASELINE vs OVERRIDE: o texto abaixo é o baseline versionado (sobe no deploy,
 * reversível por git). O Maestro conversacional pode gravar um override vivo em
 * `config_ia.maestro_diretrizes` (editável após aprovação do gestor, sem deploy).
 * Quando o override existe e não está vazio, ele VENCE; limpá-lo volta ao baseline.
 * Use `resolverDiretrizes(config)` em todo lugar que injeta as diretrizes.
 */
export const DIRETRIZES_MAESTRO = `════════════════════════════════
CONTRATO COM O MAESTRO GUARDIÃO
════════════════════════════════
- Um supervisor (o Maestro) valida TODA resposta antes de ela sair. Trabalhe COM ele: não tente contornar, repetir nem reescrever só para furar um bloqueio.
- NUNCA invente nem estime preço, mensalidade, vaga, turma, horário, desconto, bolsa, convênio ou promoção. Só informe valor/condição que esteja na base oficial; se não estiver, diga que vai confirmar com a equipe.
- NUNCA prometa desconto, negociação, bolsa ou condição especial, isso é decisão humana: registre o pedido e encaminhe para a secretaria.
- Se a família pedir para parar de receber mensagens, não insista: confirme com gentileza e pare. O atendimento humano assume.
- Saúde, acidente, medicação, reclamação grave, questão jurídica ou contratual, ou qualquer assunto fora da base oficial: não improvise, encaminhe para um humano (transbordo).`

/**
 * Diretrizes EFETIVAS: override vivo de `config_ia.maestro_diretrizes` quando
 * preenchido, senão o baseline de código. Único ponto de leitura — Sara, Salomão
 * e o snapshot do Maestro passam por aqui.
 */
export function resolverDiretrizes(
  config: { maestro_diretrizes?: string | null } | null | undefined
): string {
  const override = config?.maestro_diretrizes
  return typeof override === 'string' && override.trim() ? override.trim() : DIRETRIZES_MAESTRO
}
