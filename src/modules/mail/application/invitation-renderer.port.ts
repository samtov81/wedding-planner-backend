export interface DatosInvitacion {
  guestName: string
  eventName: string
  weddingDate: string
  rsvpUrl: string
}

/**
 * Puerto de la plantilla de invitación.
 *
 * DESIGN-GAP: el brief de la Tarea 12 hace que el worker importe
 * `renderGuestInvitation` directamente de `mail/infrastructure/templates`. Eso
 * cruza la frontera de otro módulo por sus tripas y lo rechaza la regla
 * `modulos-no-se-tocan-las-tripas` del gate de arquitectura. La plantilla se
 * publica aquí como puerto —`MailModule` lo provee con la implementación de
 * React Email y lo exporta— y el worker depende del puerto, no del render.
 */
export interface InvitationRenderer {
  render(datos: DatosInvitacion): Promise<{ html: string; text: string }>
}

export const INVITATION_RENDERER = Symbol('INVITATION_RENDERER')
