import { Inject, Injectable } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import {
  EventoNoEncontradoError,
  InvitadoSinCuentaError,
  YaEsMiembroError,
} from '../domain/event-errors'
import type { EventRole } from '../domain/event-access'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

export interface DatosInvitarMiembro {
  eventId: string
  email: string
  role: EventRole
  invitedById: string
}

@Injectable()
export class InviteMemberUseCase {
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
    await this.cola.enqueue(
      'email',
      'event-invitation',
      {
        membershipId: membresia.id,
        eventId: evento.id,
        eventName: evento.name,
        email: invitado.email,
        fullName: invitado.fullName,
        role: datos.role,
      },
      { jobId: `event-invite-${membresia.id}` },
    )

    return { id: membresia.id, status: 'INVITED' }
  }
}
