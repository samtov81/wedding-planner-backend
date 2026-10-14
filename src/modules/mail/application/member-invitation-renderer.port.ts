/**
 * Plantilla del aviso de invitación a un evento, publicada como puerto para
 * que el worker de `events` no importe `mail/infrastructure/` (regla
 * `modulos-no-se-tocan-las-tripas`). Mismo patrón que `INVITATION_RENDERER`.
 */
export interface MemberInvitationRenderer {
  render(datos: {
    fullName: string
    invitedByName: string
    eventName: string
    role: 'COUPLE' | 'PLANNER'
    appUrl: string
  }): Promise<{ html: string; text: string }>
}

export const MEMBER_INVITATION_RENDERER = Symbol('MEMBER_INVITATION_RENDERER')
