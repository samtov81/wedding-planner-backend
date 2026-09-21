import { renderGuestInvitation } from './guest-invitation'

/**
 * Hasta la Tarea 11 esta plantilla sólo se ejercitaba de refilón, desde el test
 * del worker de invitaciones de OTRO módulo. Ese import cruzaba las tripas de
 * `mail/` y la regla `tests-solo-dobles-de-otros-modulos` lo prohíbe, así que
 * el contrato del render se comprueba aquí, en su propio módulo.
 */
describe('renderGuestInvitation', () => {
  const datos = {
    guestName: 'Ana',
    eventName: 'Boda de Ana',
    weddingDate: 'June 6, 2027',
    rsvpUrl: 'https://app.test/rsvp/abc123',
  }

  it('pone el enlace de RSVP en el HTML y también en el texto plano', async () => {
    const { html, text } = await renderGuestInvitation(datos)

    // El texto no es opcional: un correo sólo-HTML puntúa peor en los filtros
    // de spam, y una invitación en spam no existe.
    expect(html).toContain(datos.rsvpUrl)
    expect(text).toContain(datos.rsvpUrl)
  })

  it('nombra al invitado y al evento', async () => {
    const { html, text } = await renderGuestInvitation(datos)

    // El render en texto plano pone los encabezados en MAYÚSCULAS, así que se
    // compara sin distinguir caja: lo que importa es que el nombre esté.
    for (const salida of [html, text]) {
      expect(salida).toContain('Ana')
      expect(salida.toLowerCase()).toContain('boda de ana')
    }
  })
})
