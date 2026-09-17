import { FakeMailAdapter } from './fake-mail.adapter'

describe('FakeMailAdapter', () => {
  it('acumula lo enviado para poder assertar sobre ello', async () => {
    const mail = new FakeMailAdapter()

    const resultado = await mail.send({
      to: 'ana@test.com',
      subject: 'Estás invitada',
      html: '<p>Hola</p>',
      text: 'Hola',
    })

    expect(mail.enviados).toHaveLength(1)
    expect(mail.enviados[0]?.to).toBe('ana@test.com')
    expect(resultado.providerMessageId).toMatch(/^fake-/)
  })

  it('devuelve un id distinto por envío, como haría el proveedor real', async () => {
    const mail = new FakeMailAdapter()
    const base = { subject: 's', html: 'h', text: 't' }

    const a = await mail.send({ ...base, to: 'a@test.com' })
    const b = await mail.send({ ...base, to: 'b@test.com' })

    expect(a.providerMessageId).not.toBe(b.providerMessageId)
  })

  it('puede simular un fallo del proveedor para probar los reintentos', async () => {
    const mail = new FakeMailAdapter()
    mail.fallarProximoEnvio(new Error('proveedor caído'))

    await expect(
      mail.send({ to: 'a@test.com', subject: 's', html: 'h', text: 't' }),
    ).rejects.toThrow('proveedor caído')
    expect(mail.enviados).toHaveLength(0)
  })
})
