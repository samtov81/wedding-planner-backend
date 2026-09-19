import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { InvitacionNoValidaError } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'
import { buscarInvitacionRespondible } from './invitacion-valida'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'

/**
 * Tipo de la notificación, nombre del job en la cola `notifications` y evento
 * de socket que emitirá el worker. La Tarea 15 lo escucha por este nombre.
 */
export const TIPO_RSVP_ACTUALIZADO = 'guest.rsvp.updated'

/**
 * Lo que el worker de `notifications` (Tarea 15) recibe: a qué sala emitir y
 * qué. Sin token ni correos: el payload se guarda en Redis.
 */
export interface JobAvisoRsvp {
  eventId: string
  payload: { guestId: string; guestName: string; rsvp: 'CONFIRMED' | 'DECLINED' }
}

/**
 * Único por RESPUESTA, no por invitación: el invitado puede cambiar su RSVP
 * (bloque A §2), y con `rsvp-<invitationId>` BullMQ descartaría el segundo
 * cambio por jobId repetido. `respondidaEn` es el mismo `ahora` que se escribe
 * en `respondedAt`. Con `-`, nunca `:` (BullMQ lo rechaza; ver
 * `EnqueueOptions.jobId`).
 */
export function jobIdDeAvisoRsvp(invitationId: string, respondidaEn: Date): string {
  return `rsvp-${invitationId}-${respondidaEn.getTime()}`
}

/**
 * La respuesta del invitado. `dietary` ausente = no se toca la que hubiera;
 * `null` = el invitado la borra. Son dos cosas distintas y el borde HTTP las
 * conserva distintas.
 */
export interface RespuestaRsvp {
  rsvp: 'CONFIRMED' | 'DECLINED'
  dietary?: string | null | undefined
}

@Injectable()
export class SubmitRsvpUseCase {
  private readonly registro = new Logger(SubmitRsvpUseCase.name)

  constructor(
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository,
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  /**
   * Orden no negociable: validar → persistir TODO en una transacción → encolar.
   *
   * La validación distingue dos rechazos: token inexistente o caducado → el 404
   * `INVITATION_INVALID` de siempre; token vivo pasado el cierre → 422
   * `RSVP_CLOSED`. Un token ya respondido NO se rechaza: el invitado puede
   * cambiar su respuesta hasta el cierre (bloque A §2).
   *
   * Dentro de la transacción: marcar la invitación (RESPONDED), actualizar el
   * invitado y crear las notificaciones. O las tres o ninguna: una respuesta sin
   * notificación sería un cambio que la pareja no ve nunca si no estaba
   * conectada, y una invitación RESPONDED con el invitado aún PENDING mentiría
   * a la pareja sobre quién ha contestado. Cada respuesta, también cada cambio,
   * crea sus notificaciones y encola su propio aviso.
   *
   * El aviso en tiempo real NO se emite desde aquí (ruling C23): tras el commit
   * se ENCOLA un job en `notifications`, y quien emite es el worker de la
   * Tarea 15 — otro proceso, con reintentos que un emit dentro de la petición
   * no tiene. Encolar va FUERA y DESPUÉS del commit: dentro, una caída de Redis
   * desharía la respuesta del invitado; antes, la pareja podría ver un cambio
   * que luego no se confirma. Si encolar falla, se registra y se traga: la
   * respuesta y la `Notification` ya están persistidas y se recuperan por REST.
   *
   * El token NUNCA se registra: ni aquí ni en los errores. Los logs llevan
   * `eventId` y `guestId`, que bastan para seguir el caso y no dan acceso a nada.
   */
  async ejecutar(token: string, respuesta: RespuestaRsvp): Promise<void> {
    const ahora = new Date()
    const invitacion = await buscarInvitacionRespondible(this.invitaciones, token, ahora)
    const { eventId, id: guestId, name: guestName } = invitacion.guest
    const aviso = { guestId, guestName, rsvp: respuesta.rsvp }

    await this.unidadDeTrabajo.ejecutar(async () => {
      // La lectura de arriba no basta: un reenvío o un cambio de email (C24)
      // puede caducar el token entre ella y aquí. La guarda de verdad de la
      // caducidad es esta escritura condicionada.
      const escrita = await this.invitaciones.marcarRespondida(invitacion.id, ahora)
      if (!escrita) throw new InvitacionNoValidaError()

      await this.invitados.actualizar(eventId, guestId, {
        rsvp: respuesta.rsvp,
        ...(respuesta.dietary !== undefined ? { dietary: respuesta.dietary } : {}),
      })
      await this.notificaciones.crearParaMiembros(eventId, TIPO_RSVP_ACTUALIZADO, aviso)
    })

    const job: JobAvisoRsvp = { eventId, payload: aviso }
    try {
      await this.cola.enqueue('notifications', TIPO_RSVP_ACTUALIZADO, job, {
        jobId: jobIdDeAvisoRsvp(invitacion.id, ahora),
      })
    } catch (error) {
      this.registro.warn(
        `RSVP persistido pero su aviso no se pudo encolar eventId=${eventId} guestId=${guestId}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}
