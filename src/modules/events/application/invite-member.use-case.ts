import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort, type QueueName } from '@/modules/queue/application/queue.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import {
  EventoNoEncontradoError,
  InvitadoSinCuentaError,
  YaEsMiembroError,
} from '../domain/event-errors'
import type { EventRole } from '../domain/event-access'
import { encolarAvisoInvitacion } from './aviso-invitacion'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

/**
 * Cola PROPIA de los avisos de invitación (ruling C17). Iban a `email`, cuyo
 * worker (`auth/interfaces/email.processor.ts`) descarta con
 * `UnrecoverableError` cualquier nombre que no conoce: el aviso se perdía.
 */
export const COLA_MIEMBROS = 'members' satisfies QueueName

export interface PayloadInvitacionMiembro {
  membershipId: string
  eventId: string
  eventName: string
  email: string
  fullName: string
  role: EventRole
  invitedByName: string
}

export interface DatosInvitarMiembro {
  eventId: string
  email: string
  role: EventRole
  invitedById: string
}

@Injectable()
export class InviteMemberUseCase {
  private readonly registro = new Logger(InviteMemberUseCase.name)

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(datos: DatosInvitarMiembro): Promise<{ id: string; status: 'INVITED' }> {
    const evento = await this.eventos.buscarPorId(datos.eventId)
    if (evento === null) throw new EventoNoEncontradoError()

    const invitado = await this.usuarios.findByEmail(datos.email)
    if (invitado === null) throw new InvitadoSinCuentaError()

    // REVOKED sí se puede volver a invitar: expulsar a alguien no es una
    // condena perpetua, y la fila vieja se reutiliza (el índice único
    // (eventId, userId) no deja crear una segunda).
    const existente = await this.eventos.buscarMembresia(datos.eventId, invitado.id)
    if (existente !== null && existente.status !== 'REVOKED') throw new YaEsMiembroError()

    const membresia = await this.eventos.invitarMiembro({
      eventId: datos.eventId,
      userId: invitado.id,
      role: datos.role,
      invitedById: datos.invitedById,
    })

    const quienInvita = await this.usuarios.findById(datos.invitedById)

    // Encolado, nunca en línea: un proveedor de correo lento no puede hacer
    // fallar una invitación que ya está escrita en la base de datos.
    //
    // DESIGN-GAP: el `jobId` se deriva de la membresía, así que dos peticiones
    // idénticas (el doble clic de siempre) producen UN solo correo. El precio
    // es que re-invitar a alguien revocado dentro de la ventana de retención
    // de BullMQ (24 h, ver `OPCIONES_POR_DEFECTO`) reutiliza el mismo id y no
    // reenvía nada. Se acepta porque el doble clic es cotidiano y la
    // re-invitación en el mismo día es rarísima; lo resuelve del todo la tabla
    // de invitaciones con token propio, que todavía no existe.
    await this.cola.enqueue<PayloadInvitacionMiembro>(
      COLA_MIEMBROS,
      'member-invitation',
      {
        membershipId: membresia.id,
        eventId: evento.id,
        eventName: evento.name,
        email: invitado.email,
        fullName: invitado.fullName,
        role: datos.role,
        // Sin cuenta (no debería pasar: lo autentica el guard) se firma con el evento.
        invitedByName: quienInvita?.fullName ?? evento.name,
      },
      { jobId: `event-invite-${membresia.id}` },
    )

    // Optimización de latencia: un fallo se registra y no se propaga (ver
    // `encolarAvisoInvitacion`).
    await encolarAvisoInvitacion(
      this.cola,
      this.registro,
      { userId: invitado.id, eventId: evento.id, cambio: 'nueva' },
      membresia.id,
    )

    return { id: membresia.id, status: 'INVITED' }
  }
}
