import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { MAIL_PORT, type MailPort } from '@/modules/mail/application/mail.port'
import {
  MEMBER_INVITATION_RENDERER,
  type MemberInvitationRenderer,
} from '@/modules/mail/application/member-invitation-renderer.port'

import { COLA_MIEMBROS, type PayloadInvitacionMiembro } from '../application/invite-member.use-case'

/** Lo que sale de Redis es entrada: se valida como cualquier otra frontera. */
const payloadSchema = z.object({
  membershipId: z.string().min(1),
  eventId: z.string().min(1),
  eventName: z.string().min(1),
  email: z.email(),
  fullName: z.string().min(1),
  role: z.enum(['COUPLE', 'PLANNER']),
  invitedByName: z.string().min(1),
}) satisfies z.ZodType<PayloadInvitacionMiembro>

/**
 * Worker del aviso de invitación a un evento. Cola PROPIA (`members`, ruling
 * C17), así que el único nombre válido es `member-invitation`; otro es un bug
 * del productor y no se reintenta.
 *
 * La clave de idempotencia es por membresía: un reintento de BullMQ no manda
 * un segundo correo. Reinvitar a la misma membresía dentro de las 24 h de
 * Resend tampoco lo manda: es el mismo `DESIGN-GAP` que el `jobId` de
 * `InviteMemberUseCase`, que esta clave no empeora.
 */
@Processor(COLA_MIEMBROS)
export class MemberInvitationProcessor extends WorkerHost {
  constructor(
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(ENV) private readonly env: Env,
    @Inject(MEMBER_INVITATION_RENDERER) private readonly plantilla: MemberInvitationRenderer,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'member-invitation') {
      throw new UnrecoverableError(
        `Job de tipo desconocido en la cola '${COLA_MIEMBROS}': ${job.name}`,
      )
    }
    const leido = payloadSchema.safeParse(job.data)
    if (!leido.success) throw new UnrecoverableError('Payload de invitación a evento inválido')
    const d = leido.data

    const { html, text } = await this.plantilla.render({
      fullName: d.fullName,
      invitedByName: d.invitedByName,
      eventName: d.eventName,
      role: d.role,
      // `/dashboard` y no `/events/:id`: el invitado aún no tiene acceso, y
      // `/dashboard` le enseña sus invitaciones pendientes.
      appUrl: `${this.env.APP_URL}/dashboard`,
    })
    await this.mail.send({
      to: d.email,
      subject: `${d.invitedByName} invited you to ${d.eventName}`,
      html,
      text,
      tags: { membershipId: d.membershipId },
      idempotencyKey: `member-invitation-${d.membershipId}`,
    })
  }
}
