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
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import { NotFoundError } from '@/shared/domain'

import { accesoAlPresupuesto, type EventRole } from '../domain/event-access'
import { MiembroNoEncontradoError, SinInvitacionPendienteError } from '../domain/event-errors'
import { exigirGestionable, exigirInvitacionPendiente } from '../domain/membresia'
import { encolarAvisoInvitacion } from './aviso-invitacion'
import {
  encolarAvisoRespuesta,
  type PayloadRespuestaDeMiembro,
  TIPO_RESPUESTA_DE_MIEMBRO,
} from './aviso-respuesta-miembro'
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

    // Optimización de latencia: si Redis falla, la cancelación ya está hecha
    // (ver `encolarAvisoInvitacion`).
    await encolarAvisoInvitacion(
      this.cola,
      this.registro,
      { userId: membresia.userId, eventId: datos.eventId, cambio: 'cancelada' },
      datos.membershipId,
    )
  }
}

@Injectable()
export class ListMyInvitationsUseCase {
  constructor(@Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository) {}

  async ejecutar(userId: string): Promise<InvitacionPendiente[]> {
    return await this.eventos.listarInvitacionesPendientes(userId)
  }
}

/**
 * Lo común de aceptar y rechazar: dentro de UNA unidad de trabajo se escribe la
 * membresía y se crea la notificación del dueño; fuera, ya confirmado, se encola
 * el aviso en tiempo real (ver `aviso-respuesta-miembro.ts`).
 *
 * Si la notificación falla, la transacción deshace también la membresía: sigue
 * INVITED y sin fila de auditoría, y el invitado puede reintentar. Es el precio
 * de no perder en silencio el aviso al dueño. El doble de la unidad de trabajo
 * no deshace; eso se prueba contra Postgres.
 */
async function responder(
  dependencias: {
    eventos: EventRepository
    notificaciones: NotificationPort
    unidadDeTrabajo: UnidadDeTrabajo
    cola: QueuePort
    usuarios: UserRepository
    registro: Logger
  },
  datos: {
    eventId: string
    userId: string
    response: PayloadRespuestaDeMiembro['response']
    escribir: () => Promise<boolean>
  },
): Promise<void> {
  const { eventos, notificaciones, unidadDeTrabajo, cola, usuarios, registro } = dependencias
  const { eventId, userId, response, escribir } = datos

  // Antes de abrir la transacción: no hay por qué retenerla para una lectura.
  const usuario = await usuarios.findById(userId)
  if (usuario === null) throw new NotFoundError('User not found', 'USER_NOT_FOUND')
  const payload: PayloadRespuestaDeMiembro = { userId, fullName: usuario.fullName, response }

  await unidadDeTrabajo.ejecutar(async () => {
    if (!(await escribir())) throw new SinInvitacionPendienteError()
    await notificaciones.crearParaDueno(eventId, TIPO_RESPUESTA_DE_MIEMBRO, payload)
  })

  const evento = await eventos.buscarPorId(eventId)
  if (evento === null) return
  await encolarAvisoRespuesta(cola, registro, { eventId, ownerId: evento.ownerId }, userId)
}

@Injectable()
export class AcceptInvitationUseCase {
  private readonly registro = new Logger(AcceptInvitationUseCase.name)

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
  ) {}

  private dependencias() {
    return {
      eventos: this.eventos,
      notificaciones: this.notificaciones,
      unidadDeTrabajo: this.unidadDeTrabajo,
      cola: this.cola,
      usuarios: this.usuarios,
      registro: this.registro,
    }
  }

  async ejecutar(eventId: string, userId: string): Promise<void> {
    exigirInvitacionPendiente(await this.eventos.buscarMembresia(eventId, userId))
    await responder(this.dependencias(), {
      eventId,
      userId,
      response: 'ACCEPTED',
      escribir: () => this.eventos.aceptarInvitacion(eventId, userId),
    })
  }
}

@Injectable()
export class DeclineInvitationUseCase {
  private readonly registro = new Logger(DeclineInvitationUseCase.name)

  constructor(
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
  ) {}

  private dependencias() {
    return {
      eventos: this.eventos,
      notificaciones: this.notificaciones,
      unidadDeTrabajo: this.unidadDeTrabajo,
      cola: this.cola,
      usuarios: this.usuarios,
      registro: this.registro,
    }
  }

  /**
   * Rechazar = REVOKED (spec §3.1): no se añade `DECLINED` al enum. Quien
   * actúa es el propio invitado, y el `AuditLog` lo registra como `declined`.
   */
  async ejecutar(eventId: string, userId: string): Promise<void> {
    const membresia = await this.eventos.buscarMembresia(eventId, userId)
    exigirInvitacionPendiente(membresia)
    await responder(this.dependencias(), {
      eventId,
      userId,
      response: 'DECLINED',
      escribir: () => this.eventos.revocarMembresia(eventId, membresia.id, userId, 'declined'),
    })
  }
}
