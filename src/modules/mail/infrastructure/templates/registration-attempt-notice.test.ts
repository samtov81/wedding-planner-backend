import { renderRegistrationAttemptNotice } from './registration-attempt-notice'

/**
 * Este correo lo recibe quien YA tiene cuenta cuando alguien intenta
 * registrarse con su dirección. Su propiedad crítica es negativa: no puede
 * llevar nada accionable. Es la pieza que permite responder 201 en las dos
 * ramas de `/auth/register` sin regalar un vector de toma de cuentas.
 */
describe('renderRegistrationAttemptNotice', () => {
  const datos = { fullName: 'Ana' }

  it('nombra al destinatario en el HTML y en el texto plano', async () => {
    const { html, text } = await renderRegistrationAttemptNotice(datos)

    for (const salida of [html, text]) {
      expect(salida).toContain('Ana')
    }
  })

  it('no lleva NINGÚN enlace: ni de verificación, ni de restablecer, ni token', async () => {
    const { html, text } = await renderRegistrationAttemptNotice(datos)

    // Quien provoca el aviso no es quien lo recibe: si el correo trajera un
    // enlace de verificación o de recuperación, bastaría con tener acceso a
    // ese buzón —o con que el correo se reenvíe— para tomar la cuenta.
    expect(html).not.toContain('href=')
    expect(html).not.toContain('verify-email')
    expect(html).not.toContain('token')
    expect(text).not.toContain('http')
  })

  it('no revela la contraseña ni el nombre que escribió quien intentó registrarse', async () => {
    const { html, text } = await renderRegistrationAttemptNotice(datos)

    // La plantilla sólo recibe `fullName` de la cuenta existente: no hay sitio
    // donde colar los datos del tercero. Se fija aquí para que no se añadan.
    for (const salida of [html, text]) {
      expect(salida.toLowerCase()).not.toContain('password')
    }
  })

  it('escapa el nombre en el HTML', async () => {
    const { html } = await renderRegistrationAttemptNotice({ fullName: '<script>alert(1)</script>' })

    expect(html).not.toContain('<script>')
  })
})
