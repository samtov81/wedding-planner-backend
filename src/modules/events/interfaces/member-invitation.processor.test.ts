import { UnrecoverableError, type Job } from 'bullmq'

import type { Env } from '@/config/env.schema'
import type { MemberInvitationRenderer } from '@/modules/mail/application/member-invitation-renderer.port'
import { FakeMailAdapter } from '@/modules/mail/infrastructure/mail.adapter.fake'

import { MemberInvitationProcessor } from './member-invitation.processor'

/** Doble LOCAL de la plantilla (regla `tests-solo-dobles-de-otros-modulos`). */
const plantilla: MemberInvitationRenderer = {
  render: (d) =>
    Promise.resolve({
      html: `<a href="${d.appUrl}">${d.eventName}</a>`,
      text: `${d.invitedByName} ${d.eventName}`,
    }),
}

const PAYLOAD = {
  membershipId: 'm-1',
  eventId: 'e-1',
  eventName: 'Boda de Ana',
  email: 'pia@test.com',
  fullName: 'Pia',
  role: 'PLANNER',
  invitedByName: 'Ana',
}

describe('MemberInvitationProcessor', () => {
  let mail: FakeMailAdapter
  let procesador: MemberInvitationProcessor

  beforeEach(() => {
    mail = new FakeMailAdapter()
    procesador = new MemberInvitationProcessor(
      mail,
      { APP_URL: 'https://app.test' } as Env,
      plantilla,
    )
  })

  it('manda el aviso al invitado, enlazando a /dashboard, con clave por membresía', async () => {
    await procesador.process({ name: 'member-invitation', data: PAYLOAD } as Job)
    expect(mail.enviados).toEqual([
      expect.objectContaining({
        to: 'pia@test.com',
        subject: 'Ana invited you to Boda de Ana',
        html: '<a href="https://app.test/dashboard">Boda de Ana</a>',
        idempotencyKey: 'member-invitation-m-1',
      }),
    ])
  })

  it('un payload roto no se reintenta', async () => {
    await expect(
      procesador.process({ name: 'member-invitation', data: { email: 'x' } } as Job),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mail.enviados).toEqual([])
  })

  it('un nombre de job desconocido no se reintenta', async () => {
    await expect(procesador.process({ name: 'otro', data: PAYLOAD } as Job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
  })
})
