import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
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

  /**
   * Invitaciones cuyo correo salió en el intento en curso aunque el job fallara
   * DESPUÉS, al marcarlas. Sólo sirve para que `alFallar` no las caduque.
   *
   * La protección es POR PROCESO y en memoria: un reinicio del worker entre el
   * fallo y su evento `failed` la pierde, y entonces la invitación se caduca
   * como cualquier otra sin marcar. Acotado: cada intento fallido emite
   * `failed`, que consume la marca, así que el conjunto no crece.
   *
   * DESIGN-GAP: el snippet del plan para `alFallar` no lleva esta marca. Sin
   * ella el respaldo caduca el caso que `process` protege a propósito —el
   * correo YA salió y falló el marcado en el último intento—, y el invitado se
   * queda con un enlace en la bandeja que da 404.
   */
  private readonly enviadasSinMarcar = new Set<string>()

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
      // Se decide aquí, dentro de `process`, y no sólo en el evento `failed`
      // del worker: aquí la caducidad queda escrita ANTES de que BullMQ dé el
      // job por fallido, se prueba sin Redis, y si `caducar` falla se registra
      // en vez de perderse en un emisor de eventos. `alFallar` es el RESPALDO,
      // para el job que nunca llega hasta aquí (STALLED). La regla de "último"
      // replica la de BullMQ (`Job.shouldRetryJob`): no quedan intentos, o el
      // error es `UnrecoverableError`.
      //
      // Si el correo YA salió (el fallo fue al marcar), NO se caduca: el enlace
      // está en la bandeja del invitado y caducarlo le rompería el RSVP.
      if (envio.salio) {
        // El correo SÍ salió: se le dice al respaldo del evento `failed`, que
        // no puede ver lo que pasó aquí dentro y caducaría el enlace que el
        // invitado ya tiene en su bandeja.
        this.enviadasSinMarcar.add(datos.invitationId)
      } else if (esUltimoIntento(job, error)) {
        await this.caducarSinOcultar(datos, error)
      }
      throw error
    }
  }

  /**
   * Respaldo del ruling C18 para los fallos que NO pasan por el `catch` de
   * `process`: este worker sigue vivo pero pierde el lock del job o lo mueve a
   * fallidos por su cuenta (`moveToFailed`), de modo que la caducidad de
   * `process` no llega a escribirse y el token del payload seguiría vivo en el
   * conjunto de fallidos de Redis. Cuando BullMQ da el job por perdido (sin
   * intentos restantes), se caduca la invitación igual.
   *
   * DESIGN-GAP: el caso del worker MUERTO no queda cubierto. `@OnWorkerEvent`
   * escucha el `failed` local del worker, que sólo emite `handleFailed`; un job
   * atascado porque su worker se cayó lo marca fallido el script Lua de BullMQ
   * y sólo aflora como `failed` GLOBAL de `QueueEvents`. Se deja así en este
   * bloque (el plan manda `@OnWorkerEvent`): cubrir al worker muerto pide un
   * `QueueEvents` o un barrido periódico de caducidades, y va a bloque B.
   *
   * Es idempotente con la caducidad de `process`: caducar dos veces sólo mueve
   * `expiresAt` a un `ahora` un poco posterior, y ambos ya están en el pasado.
   */
  @OnWorkerEvent('failed')
  async alFallar(job: Job | undefined, error: Error): Promise<void> {
    // BullMQ puede emitir `failed` sin job (no pudo leerlo de Redis): sin
    // payload no hay invitación que caducar.
    if (job === undefined) return
    // Mismo criterio que `process`: un payload que no identifica invitación no
    // permite caducar nada, y reintentar no lo arregla.
    const leido = payloadInvitacionSchema.safeParse(job.data)
    if (!leido.success) return
    // El correo de este intento ya salió (falló el marcado): misma regla que
    // `process`, no se caduca lo que el invitado tiene en la bandeja. Se
    // consume la marca aunque queden intentos: el siguiente la vuelve a poner.
    if (this.enviadasSinMarcar.delete(leido.data.invitationId)) return
    const quedan = (job.opts.attempts ?? 1) - job.attemptsMade
    if (quedan > 0 && !esIrrecuperable(error)) return
    await this.caducarSinOcultar(leido.data, error)
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

  /** Por qué se descarta un job. Con los ids, NUNCA con el token del payload. */
  private registrarDescarte(datos: PayloadInvitacion, motivo: string): void {
    this.registro.log(
      `Job de invitación descartado, ${motivo} invitationId=${datos.invitationId} ` +
        `requestId=${datos.requestId}`,
    )
  }

  private async enviar(datos: PayloadInvitacion, envio: { salio: boolean }): Promise<void> {
    const invitacion = await this.invitaciones.buscarConInvitadoYEvento(datos.invitationId)

    // La invitación pudo borrarse entre el encolado y el procesado. No es un
    // error: se descarta el job sin reintentar, porque reintentar no la va a
    // hacer aparecer. Se dice por qué: un job completado sin rastro es un
    // correo que no llega y ninguna explicación.
    if (invitacion === null) {
      this.registrarDescarte(datos, 'la invitación ya no existe')
      return
    }

    // Ya enviada: esto es una reentrega tardía del mismo job. Salir aquí es lo
    // que impide el segundo correo.
    if (invitacion.status !== 'QUEUED') {
      this.registrarDescarte(datos, `la invitación ya no está en cola (${invitacion.status})`)
      return
    }

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
    if (invitacion.guest.email === null) {
      this.registrarDescarte(datos, 'el invitado se quedó sin email')
      return
    }

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
    //
    // Sin id (409 de idempotencia de Resend, bloque A §5) se marca SENT
    // igualmente con `null`: el correo salió, y lo que se pierde es sólo poder
    // casar sus webhooks de entrega. Dejarla QUEUED sería peor: el reintento
    // volvería a chocar con la misma clave y acabaría caducando un enlace vivo.
    await this.invitaciones.marcarEnviada(invitacion.id, providerMessageId ?? null)
  }
}

/** Misma regla que `Job.shouldRetryJob` de BullMQ, vista desde dentro del intento. */
function esUltimoIntento(job: Job, error: unknown): boolean {
  if (esIrrecuperable(error)) return true
  // `attemptsMade` cuenta los intentos YA terminados; éste es el `+ 1`.
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
}

/**
 * También POR NOMBRE: el error que llega al evento `failed` viaja serializado
 * por Redis y vuelve como un `Error` corriente, así que el `instanceof` no lo
 * reconoce. Y un `UnrecoverableError` de otra copia de `bullmq` en el árbol de
 * dependencias tampoco casaría por prototipo. Mismo criterio que BullMQ, que
 * marca el job como fallido definitivo por su nombre.
 */
function esIrrecuperable(error: unknown): boolean {
  if (error instanceof UnrecoverableError) return true
  return error instanceof Error && error.name === 'UnrecoverableError'
}

/** Fecha legible en el correo. UTC explícito: el worker no está en la zona de la boda. */
function formatearFecha(fecha: Date): string {
  return fecha.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })
}
