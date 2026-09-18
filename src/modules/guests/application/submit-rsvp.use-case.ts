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
import { buscarInvitacionValida } from './invitacion-valida'
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
 * Una invitación sólo se responde una vez, así que su id basta para que un
 * reintento de la petición no encole dos avisos. Con `-`, nunca `:` (BullMQ lo
 * rechaza; ver `EnqueueOptions.jobId`).
 */
export function jobIdDeAvisoRsvp(invitationId: string): string {
  return `rsvp-${invitationId}`
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
   * Dentro de la transacción: reclamar la invitación (RESPONDED), actualizar el
   * invitado y crear las notificaciones. O las tres o ninguna: una respuesta sin
   * notificación sería un cambio que la pareja no ve nunca si no estaba
   * conectada, y una invitación RESPONDED con el invitado aún PENDING dejaría
   * al invitado sin forma de contestar (su token ya no vale).
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
    const invitacion = await buscarInvitacionValida(this.invitaciones, token, ahora)
    const { eventId, id: guestId, name: guestName } = invitacion.guest
    const aviso = { guestId, guestName, rsvp: respuesta.rsvp }

    await this.unidadDeTrabajo.ejecutar(async () => {
      // La lectura de arriba no basta: dos respuestas simultáneas la pasan las
      // dos. La guarda de verdad es esta escritura condicionada.
      const reclamada = await this.invitaciones.marcarRespondida(invitacion.id, ahora)
      if (!reclamada) throw new InvitacionNoValidaError()

      await this.invitados.actualizar(eventId, guestId, {
        rsvp: respuesta.rsvp,
        ...(respuesta.dietary !== undefined ? { dietary: respuesta.dietary } : {}),
      })
      await this.notificaciones.crearParaMiembros(eventId, TIPO_RSVP_ACTUALIZADO, aviso)
    })

    const job: JobAvisoRsvp = { eventId, payload: aviso }
    try {
      await this.cola.enqueue('notifications', TIPO_RSVP_ACTUALIZADO, job, {
        jobId: jobIdDeAvisoRsvp(invitacion.id),
      })
    } catch (error) {
      this.registro.warn(
        `RSVP persistido pero su aviso no se pudo encolar eventId=${eventId} guestId=${guestId}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}
