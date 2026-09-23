import { renderPasswordChanged } from './password-changed'

describe('renderPasswordChanged', () => {
  const datos = {
    fullName: 'Ana',
    cambiadoEn: new Date('2026-09-22T10:00:00.000Z'),
    recoverUrl: 'https://app.test/forgot-password',
  }

  it('avisa del cambio, con la fecha, y nombra al destinatario', async () => {
    const { text } = await renderPasswordChanged(datos)
    expect(text).toContain('Ana')
    expect(text).toContain('Tue, 22 Sep 2026 10:00:00 GMT')
  })

  it('dice que se cerraron las sesiones y ofrece recuperar la cuenta', async () => {
    const { html, text } = await renderPasswordChanged(datos)
    expect(text.toLowerCase()).toContain('signed out')
    expect(html).toContain('https://app.test/forgot-password')
  })

  it('no lleva ningún token', async () => {
    const { html } = await renderPasswordChanged(datos)
    expect(html).not.toContain('token=')
  })
})
