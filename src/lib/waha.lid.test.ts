import { describe, it, expect } from 'vitest'
import { resolverTelefoneWaha } from './waha'

// Caso Elen 26/11: @lid chegou no chip Salomao-crm (final 0916) e era descartado
// porque o CRM perguntava o número à sessão errada. O engine GOWS já manda o número
// real em _data.Info.SenderAlt — ele resolve sem consulta nenhuma ao WAHA.
describe('resolverTelefoneWaha — @lid com número alternativo do evento', () => {
  it('usa o SenderAlt (@s.whatsapp.net) quando o from é @lid', async () => {
    const r = await resolverTelefoneWaha('99900011122233@lid', { alt: '556899990000@s.whatsapp.net' })
    expect(r).toEqual({ telefone: '556899990000', via: 'sender-alt' })
  })

  it('c.us continua resolvendo direto, ignorando o alt', async () => {
    const r = await resolverTelefoneWaha('556811112222@c.us', { alt: '556899990000@s.whatsapp.net' })
    expect(r).toEqual({ telefone: '556811112222', via: 'c.us' })
  })
})
