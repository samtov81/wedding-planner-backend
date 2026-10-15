import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { accesoAlPresupuesto, type EventRole } from '../domain/event-access'
import { MiembroNoEncontradoError, SinInvitacionPendienteError } from '../domain/event-errors'
import { exigirGestionable, exigirInvitacionPendiente } from '../domain/membresia'
import {
  jobIdDeAvisoInvitacion,
  TIPO_INVITACION_DE_MIEMBRO,
  type JobInvitacionDeMiembro,
} from './aviso-invitacion'
import {
  EVENT_REPOSITORY,
  type EventRepository,
  type InvitacionPendiente,
  type MiembroPersistido,
} from './event.repository'

/** Un miembro tal como lo ve quien gestiona: el grant ya traducido a nivel. */
export interface Miembro {
  id: string
  userId: string
  fullName: string
  email: string
  role: EventRole
  status: 'INVITED' | 'ACTIVE'
  owner: boolean
  budgetAccess: 'none' | 'view' | 'edit'
}

function aMiembro({ budgetView, ...m }: MiembroPersistido): Miembro {
  // Una sola regla del presupuesto: la de `accesoAlPresupuesto` (el creador es
  // `edit` aunque no tenga grant).
  return {
    ...m,
    budgetAccess: accesoAlPresupuesto({ kind: 'member', role: m.role, owner: m.owner, budgetView }),
  }
}

@Injectable()
export class ListMembersUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(eventId: string): Promise<Miembro[]> {
    return (await this.eventos.listarMiembros(eventId)).map(aMiembro)
  }
}

@Injectable()
export class UpdateMemberUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(datos: {
    eventId: string
    membershipId: string
    actorId: string
    role?: EventRole | undefined
    budgetAccess?: 'none' | 'view' | undefined
  }): Promise<Miembro> {
    exigirGestionable(await this.eventos.buscarMembresiaPorId(datos.eventId, datos.membershipId))
    const escrito = await this.eventos.actualizarMembresia(
      datos.eventId,
      datos.membershipId,
      {
        role: datos.role,
        budgetView: datos.budgetAccess === undefined ? undefined : datos.budgetAccess === 'view',
      },
      datos.actorId,
    )
    // Revocada entre la lectura y la escritura: para quien gestiona ya no existe.
    if (!escrito) throw new MiembroNoEncontradoError()
    // Sólo su fila: releer la lista entera del evento para quedarse con una era
    // trabajo de más en cada PATCH.
    const actualizado = await this.eventos.buscarMiembro(datos.eventId, datos.membershipId)
    if (actualizado === null) throw new MiembroNoEncontradoError()
    return aMiembro(actualizado)
  }
}

@Injectable()
export class RevokeMemberUseCase {
  private readonly registro = new Logger(RevokeMemberUseCase.name)

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  /**
   * Revocar a un ACTIVE y cancelar una INVITED son la misma escritura. Sólo la
   * cancelación avisa en tiempo real (spec 2026-10-14 §3.1): es lo que cambia
   * las invitaciones pendientes del invitado.
   */
  async ejecutar(datos: { eventId: string; membershipId: string; actorId: string }): Promise<void> {
    const membresia = await this.eventos.buscarMembresiaPorId(datos.eventId, datos.membershipId)
    exigirGestionable(membresia)
    const escrito = await this.eventos.revocarMembresia(
      datos.eventId,
      datos.membershipId,
      datos.actorId,
      'revoked',
    )
    if (!escrito) throw new MiembroNoEncontradoError()
    if (membresia.status !== 'INVITED') return

    // Optimización de latencia: si Redis falla, la cancelación ya está hecha.
    const aviso: JobInvitacionDeMiembro = {
      userId: membresia.userId,
      eventId: datos.eventId,
      cambio: 'cancelada',
    }
    try {
      await this.cola.enqueue('notifications', TIPO_INVITACION_DE_MIEMBRO, aviso, {
        jobId: jobIdDeAvisoInvitacion(datos.membershipId, new Date()),
      })
    } catch (error) {
      this.registro.warn(
        `Invitación cancelada pero su aviso no se pudo encolar eventId=${datos.eventId} membershipId=${datos.membershipId}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}

@Injectable()
export class ListMyInvitationsUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(userId: string): Promise<InvitacionPendiente[]> {
    return await this.eventos.listarInvitacionesPendientes(userId)
  }
}

@Injectable()
export class AcceptInvitationUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(eventId: string, userId: string): Promise<void> {
    exigirInvitacionPendiente(await this.eventos.buscarMembresia(eventId, userId))
    if (!(await this.eventos.aceptarInvitacion(eventId, userId))) {
      throw new SinInvitacionPendienteError()
    }
  }
}

@Injectable()
export class DeclineInvitationUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  /**
   * Rechazar = REVOKED (spec §3.1): no se añade `DECLINED` al enum. Quien
   * actúa es el propio invitado, y el `AuditLog` lo registra como `declined`.
   */
  async ejecutar(eventId: string, userId: string): Promise<void> {
    const membresia = await this.eventos.buscarMembresia(eventId, userId)
    exigirInvitacionPendiente(membresia)
    if (!(await this.eventos.revocarMembresia(eventId, membresia.id, userId, 'declined'))) {
      throw new SinInvitacionPendienteError()
    }
  }
}
