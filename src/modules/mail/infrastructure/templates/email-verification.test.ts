import { renderEmailVerification } from './email-verification'

describe('renderEmailVerification', () => {
  const datos = {
    fullName: 'Ana',
    verifyUrl: 'https://app.test/verify-email?token=abc123',
  }

  it('pone el enlace de verificación en el HTML y también en el texto plano', async () => {
    const { html, text } = await renderEmailVerification(datos)

    // El texto no es opcional: un correo sólo-HTML puntúa peor en los filtros
    // de spam, y un correo de verificación en spam bloquea el alta entera.
    expect(html).toContain('abc123')
    expect(text).toContain('abc123')
  })

  it('el enlace también va como texto, no sólo dentro del botón', async () => {
    const { html } = await renderEmailVerification(datos)

    // Muchos clientes de correo corporativos desactivan los botones o reescriben
    // el `href`: sin el enlace visible, el usuario se queda sin salida.
    const apariciones = html.split('abc123').length - 1
    expect(apariciones).toBeGreaterThanOrEqual(2)
  })

  it('nombra al destinatario', async () => {
    const { html, text } = await renderEmailVerification(datos)

    for (const salida of [html, text]) {
      expect(salida).toContain('Ana')
    }
  })

  it('escapa el nombre en el HTML: no se inyecta marcado desde el formulario de registro', async () => {
    // `fullName` lo escribe quien se registra y llega sin sanear al correo.
    const { html } = await renderEmailVerification({
      ...datos,
      fullName: '<script>alert(1)</script>',
    })

    expect(html).not.toContain('<script>')
  })

  it('dice cuándo caduca el enlace', async () => {
    const { text } = await renderEmailVerification(datos)

    // Quien abre el correo tres días tarde tiene que entender por qué falla.
    expect(text.toLowerCase()).toContain('expire')
  })
})
