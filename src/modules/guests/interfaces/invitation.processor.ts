import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'
import { z } from 'zod'

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
import {
  COLA_INVITACIONES,
  jobIdDeInvitacion,
  type PayloadInvitacion,
} from '../application/send-invitations.use-case'

/**
 * Lo que sale de Redis es ENTRADA: otro proceso lo escribió y puede venir de una
 * versión anterior del código. Se valida como cualquier otra frontera.
 */
const payloadInvitacionSchema = z.object({
  invitationId: z.string().min(1),
  token: z.string().min(1),
  requestId: z.string(),
}) satisfies z.ZodType<PayloadInvitacion>

/**
 * Worker de las invitaciones. Vive en `interfaces/` por el mismo motivo que un
 * controlador: es una PUERTA de entrada al sistema —la de la cola en vez de la
 * de HTTP—, no una regla de negocio.
 *
 * Qué evita un segundo correo, y qué no. BullMQ garantiza "al menos una vez":
 *  - REENTREGA del mismo job con la invitación ya SENT: la guarda de `status`.
 *  - Envío correcto y fallo DESPUÉS (`marcarEnviada` lanza, la invitación sigue
 *    QUEUED y el job se reintenta): la clave de idempotencia hacia el
 *    proveedor (`invitation-<id>`), que hace del reenvío un no-op. Resend la
 *    recuerda 24 h; un reintento fuera de esa ventana SÍ mandaría otro correo
 *    (con el backoff actual, 5 intentos desde 2 s, no se llega).
 *  - Dos envíos seguidos crean invitaciones distintas, con ids, jobIds y claves
 *    distintos (ruling C16; ver `jobIdDeInvitacion`). Desde el ruling C24 el
 *    segundo CADUCA la primera, y esta guarda de `expiresAt` impide mandarla si
 *    su job aún no había corrido; si ya había salido, llegan dos correos y sólo
 *    el último enlace funciona.
 *
 * Escucha su cola PROPIA, `invitations` (ruling C17): por eso no filtra por
 * nombre de job. Sobre la cola `email` compartida, retornar ante un job ajeno
 * lo marcaría COMPLETADO y BullMQ lo borraría sin enviarse.
 */
@Processor(COLA_INVITACIONES)
export class InvitationProcessor extends WorkerHost {
  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(ENV) private readonly env: { APP_URL: string },
    @Inject(INVITATION_RENDERER) private readonly plantilla: InvitationRenderer,
  ) {
    super()
  }

  private readonly registro = new Logger(InvitationProcessor.name)

  async process(job: Job): Promise<void> {
    const leido = payloadInvitacionSchema.safeParse(job.data)
    // Un payload roto no lo arregla ningún reintento: `UnrecoverableError` lo
    // manda directo a fallidos sin cinco intentos inútiles. Un payload que no
    // identifica invitación tampoco permite caducarla (ruling C18): si trae un
    // token, ese token sigue valiendo. Aceptado: sólo puede venir de un bug o de
    // alguien con escritura en Redis, no del flujo normal.
    if (!leido.success) throw new UnrecoverableError('Payload de invitación inválido')
    const datos = leido.data

    const envio = { salio: false }
    try {
      await this.enviar(datos, envio)
    } catch (error) {
      // ÚLTIMO intento fallido → se caduca la invitación ANTES de relanzar
      // (ruling C18). El payload, con el token en claro, puede quedarse en el
      // conjunto de fallidos de Redis sin límite (el recorte por edad no lo
      // acota); caducada, el token ya no abre nada.
      //
      // Se decide aquí, dentro de `process`, y no en el evento `failed` del
      // worker: aquí la caducidad queda escrita ANTES de que BullMQ dé el job
      // por fallido, se prueba sin Redis, y si `caducar` falla se registra en
      // vez de perderse en un emisor de eventos. La regla de "último" replica la
      // de BullMQ (`Job.shouldRetryJob`): no quedan intentos, o el error es
      // `UnrecoverableError`.
      //
      // Si el correo YA salió (el fallo fue al marcar), NO se caduca: el enlace
      // está en la bandeja del invitado y caducarlo le rompería el RSVP.
      if (!envio.salio && esUltimoIntento(job, error)) {
        await this.caducarSinOcultar(datos, error)
      }
      throw error
    }
  }

  private async caducarSinOcultar(datos: PayloadInvitacion, original: unknown): Promise<void> {
    try {
      await this.invitaciones.caducar(datos.invitationId)
    } catch (fallo) {
      // Se registra y se sigue: el error que BullMQ debe ver es el ORIGINAL.
      this.registro.error(
        `No se pudo caducar la invitación invitationId=${datos.invitationId} ` +
          `requestId=${datos.requestId} tras agotar intentos (${String(original)})`,
        fallo instanceof Error ? fallo.stack : String(fallo),
      )
    }
  }

  private async enviar(datos: PayloadInvitacion, envio: { salio: boolean }): Promise<void> {
    const invitacion = await this.invitaciones.buscarConInvitadoYEvento(datos.invitationId)

    // La invitación pudo borrarse entre el encolado y el procesado. No es un
    // error: se descarta el job sin reintentar, porque reintentar no la va a
    // hacer aparecer.
    if (invitacion === null) return

    // Ya enviada: esto es una reentrega tardía del mismo job. Salir aquí es lo
    // que impide el segundo correo.
    if (invitacion.status !== 'QUEUED') return

    // Caducada mientras el job esperaba: un reenvío o un cambio de email la
    // sustituyó (ruling C24), o agotó intentos antes. Mandarla sería mandar un
    // enlace que ya da 404, quizá a la dirección equivocada. Se descarta sin
    // reintentar (ningún reintento la revive) y se dice por qué: id, NUNCA token.
    if (invitacion.expiresAt.getTime() <= Date.now()) {
      this.registro.warn(
        `Invitación caducada antes de enviarse, no se manda invitationId=${invitacion.id} ` +
          `requestId=${datos.requestId}`,
      )
      return
    }

    // El correo pudo borrarse del invitado después de encolar. Lanzar sería
    // reintentar cinco veces algo que ningún reintento arregla; el envío
    // masivo ya reporta este caso como `NO_EMAIL`.
    if (invitacion.guest.email === null) return

    const { html, text } = await this.plantilla.render({
      guestName: invitacion.guest.name,
      eventName: invitacion.event.name,
      weddingDate: formatearFecha(invitacion.event.weddingDate),
      rsvpUrl: `${this.env.APP_URL}/rsvp/${datos.token}`,
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
      idempotencyKey: jobIdDeInvitacion(invitacion.id),
    })
    envio.salio = true

    // SENT y el id del proveedor en la misma escritura: el webhook (Tarea 13)
    // casa por `resendMessageId`, así que si esto falla el webhook llega a una
    // invitación que no sabe reconocer.
    await this.invitaciones.marcarEnviada(invitacion.id, providerMessageId)
  }
}

/** Misma regla que `Job.shouldRetryJob` de BullMQ, vista desde dentro del intento. */
function esUltimoIntento(job: Job, error: unknown): boolean {
  if (error instanceof UnrecoverableError) return true
  // `attemptsMade` cuenta los intentos YA terminados; éste es el `+ 1`.
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
}

/** Fecha legible en el correo. UTC explícito: el worker no está en la zona de la boda. */
function formatearFecha(fecha: Date): string {
  return fecha.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })
}
