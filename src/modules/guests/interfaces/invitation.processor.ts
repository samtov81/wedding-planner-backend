import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject } from '@nestjs/common'
import type { Job } from 'bullmq'

import { ENV } from '@/config/config.module'
import {
  INVITATION_RENDERER,
  type InvitationRenderer,
} from '@/modules/mail/application/invitation-renderer.port'
import { MAIL_PORT, type MailPort } from '@/modules/mail/application/mail.port'

import {
  INVITATION_REPOSITORY,
  type InvitationRepository,
} from '../application/invitation.repository'
import { COLA_EMAIL, type PayloadInvitacion } from '../application/send-invitations.use-case'

/**
 * Worker de las invitaciones. Vive en `interfaces/` por el mismo motivo que un
 * controlador: es una PUERTA de entrada al sistema —la de la cola en vez de la
 * de HTTP—, no una regla de negocio.
 *
 * Es idempotente por dos vías independientes: el `jobId` determinista impide
 * que se encolen dos jobs para la misma invitación, y la guarda de `status`
 * impide que una REENTREGA del mismo job mande un segundo correo. Hacen falta
 * las dos: BullMQ garantiza "al menos una vez", no "exactamente una vez".
 */
@Processor(COLA_EMAIL)
export class InvitationProcessor extends WorkerHost {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(ENV) private readonly env: { APP_URL: string },
    @Inject(INVITATION_RENDERER) private readonly plantilla: InvitationRenderer,
  ) {
    super()
  }

  async process(job: Job<PayloadInvitacion>): Promise<void> {
    const invitacion = await this.invitaciones.buscarConInvitadoYEvento(job.data.invitationId)

    // La invitación pudo borrarse entre el encolado y el procesado. No es un
    // error: se descarta el job sin reintentar, porque reintentar no la va a
    // hacer aparecer.
    if (invitacion === null) return

    // Ya enviada: esto es una reentrega tardía del mismo job. Salir aquí es lo
    // que impide el segundo correo.
    if (invitacion.status !== 'QUEUED') return

    // El correo pudo borrarse del invitado después de encolar. Lanzar sería
    // reintentar cinco veces algo que ningún reintento arregla; el envío
    // masivo ya reporta este caso como `NO_EMAIL`.
    if (invitacion.guest.email === null) return

    const { html, text } = await this.plantilla.render({
      guestName: invitacion.guest.name,
      eventName: invitacion.event.name,
      weddingDate: formatearFecha(invitacion.event.weddingDate),
      rsvpUrl: `${this.env.APP_URL}/rsvp/${job.data.token}`,
    })

    // Si el proveedor falla, este `await` LANZA y el error sale del worker sin
    // capturar: es lo único que hace que BullMQ reintente. Capturar y registrar
    // marcaría el job como completado y dejaría la invitación en QUEUED para
    // siempre.
    const { providerMessageId } = await this.mail.send({
      to: invitacion.guest.email,
      subject: `You are invited to ${invitacion.event.name}`,
      html,
      text,
      tags: { eventId: invitacion.event.id, invitationId: invitacion.id },
    })

    // SENT y el id del proveedor en la misma escritura: el webhook (Tarea 13)
    // casa por `resendMessageId`, así que si esto falla el webhook llega a una
    // invitación que no sabe reconocer.
    await this.invitaciones.marcarEnviada(invitacion.id, providerMessageId)
  }
}

/** Fecha legible en el correo. UTC explícito: el worker no está en la zona de la boda. */
function formatearFecha(fecha: Date): string {
  return fecha.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })
}
