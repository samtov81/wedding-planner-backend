import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
  TIPO_CRONOGRAMA_CONFIRMACION,
} from '@/modules/notifications/application/notification.port'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { normalizarNota } from '../domain/participacion'
import {
  ItemDeCronogramaNoEncontradoError,
  ProveedorNoAsignableError,
  SoloPlannerError,
} from '../domain/schedule-errors'
import { encolarCampana, encolarRecordatorios } from './avisos-cronograma'
import {
  type Asignable,
  type EstadoProveedor,
  type ItemConAsignaciones,
  type NotaDeItem,
  type PendienteDeProveedor,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'
import type { ActorDelCronograma } from './update-schedule-item.use-case'

/**
 * Casos de uso de la participación de proveedores en el cronograma (spec
 * 2026-11-10 §3–§7): asignar, notas del planner, confirmaciones y "Notify
 * Vendors". Crear y editar ítems siguen en sus ficheros de siempre, que
 * reutilizan `exigirAsignables` de aquí.
 *
 * Un fichero para todos, como `moodboard.use-cases.ts`: son pequeños y
 * comparten dependencias y el patrón "escribir en una unidad de trabajo,
 * encolar tras el commit". Reciben el actor ya traducido por el controlador
 * (`esPlanner`), nunca el `EventAccess`.
 */

/**
 * 422 si algún id no está entre las asignables del evento (`BOOKED` con
 * ficha, spec 2026-11-10 §3). Como `listarAsignables` filtra por evento, esto
 * rechaza también la contratación de OTRO evento sin una comprobación aparte.
 * Lleva TODOS los rechazados, en el orden pedido y sin repetir.
 */
export async function exigirAsignables(
  repo: ScheduleItemRepository,
  eventId: string,
  eventVendorIds: readonly string[],
): Promise<void> {
  if (eventVendorIds.length === 0) return
  const asignables = new Set((await repo.listarAsignables(eventId)).map((a) => a.eventVendorId))
  const rechazados = [...new Set(eventVendorIds)].filter((id) => !asignables.has(id))
  if (rechazados.length > 0) throw new ProveedorNoAsignableError(rechazados)
}

function exigirPlanner(actor: ActorDelCronograma): void {
  if (!actor.esPlanner) throw new SoloPlannerError()
}

/**
 * Deja el ítem asignado exactamente a `eventVendorIds` (PUT: la lista es la
 * verdad). Sólo el planner. Dentro de la transacción, lo primero es
 * `bloquearItems`: dos asignaciones concurrentes del mismo ítem se serializan
 * y la segunda ve las altas de la primera en vez de chocar con el UNIQUE.
 * Tras el commit, un recordatorio por cada ALTA; las bajas no borran su job
 * (el worker lo descarta al no encontrar la asignación, spec §5).
 */
@Injectable()
export class AsignarProveedoresUseCase {
  private readonly registro = new Logger(AsignarProveedoresUseCase.name)

  constructor(
    @Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    eventId: string,
    itemId: string,
    actor: ActorDelCronograma,
    eventVendorIds: string[],
  ): Promise<ItemConAsignaciones> {
    exigirPlanner(actor)
    const { item, altas } = await this.unidadDeTrabajo.ejecutar(async () => {
      await this.items.bloquearItems(eventId, [itemId])
      if ((await this.items.buscarPorId(eventId, itemId)) === null) {
        throw new ItemDeCronogramaNoEncontradoError()
      }
      await exigirAsignables(this.items, eventId, eventVendorIds)
      const { altas } = await this.items.fijarAsignaciones(itemId, eventVendorIds, actor.userId)
      const item = await this.items.buscarConAsignaciones(eventId, itemId)
      if (item === null) throw new ItemDeCronogramaNoEncontradoError()
      return { item, altas }
    })

    await encolarRecordatorios(
      this.cola,
      this.registro,
      altas.map((eventVendorId) => ({ itemId, eventVendorId, startsAt: item.startsAt })),
      new Date(),
    )
    return item
  }
}

/** Contrataciones a las que el planner puede asignar ítems (sólo el planner). */
@Injectable()
export class ListarAsignablesUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  async ejecutar(eventId: string, actor: ActorDelCronograma): Promise<Asignable[]> {
    exigirPlanner(actor)
    return await this.items.listarAsignables(eventId)
  }
}

/**
 * Para quien no es planner las notas "no existen" (spec 2026-11-10 §3): 404
 * `SCHEDULE_ITEM_NOT_FOUND`, el mismo que un ítem inexistente, y no 403, que
 * revelaría que hay algo que no puede ver. La comprobación de rol va antes de
 * tocar el repositorio, así que ni siquiera se revela si el ítem existe.
 */
async function exigirItemParaNotas(
  repo: ScheduleItemRepository,
  eventId: string,
  itemId: string,
  esPlanner: boolean,
): Promise<void> {
  if (!esPlanner) throw new ItemDeCronogramaNoEncontradoError()
  if ((await repo.buscarPorId(eventId, itemId)) === null) {
    throw new ItemDeCronogramaNoEncontradoError()
  }
}

/** Notas del ítem en orden cronológico; 404 para quien no es planner. */
@Injectable()
export class ListarNotasUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  async ejecutar(eventId: string, itemId: string, esPlanner: boolean): Promise<NotaDeItem[]> {
    await exigirItemParaNotas(this.items, eventId, itemId, esPlanner)
    return await this.items.listarNotas(itemId)
  }
}

/**
 * Añade una nota (1..2.000 caracteres tras `trim`; no se edita ni se borra,
 * spec 2026-11-10 §7). El 404 del no-planner va antes que el 422 de la nota:
 * validar el cuerpo primero le diría que la ruta existe. Sin unidad de
 * trabajo ni aviso: es una sola escritura y las notas no tienen campana.
 */
@Injectable()
export class CrearNotaUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  async ejecutar(
    eventId: string,
    itemId: string,
    actor: ActorDelCronograma,
    body: string,
  ): Promise<NotaDeItem> {
    await exigirItemParaNotas(this.items, eventId, itemId, actor.esPlanner)
    return await this.items.crearNota(itemId, actor.userId, normalizarNota(body))
  }
}

/**
 * "Vendors Ready X of Y" más, sólo para un proveedor, lo que tiene pendiente
 * (spec 2026-11-10 §4). `ready` = X, `total` = Y.
 */
export interface EstadoDeConfirmaciones {
  ready: number
  total: number
  vendors: EstadoProveedor[]
  mine: { pending: PendienteDeProveedor[] } | null
}

@Injectable()
export class ConfirmacionesUseCase {
  constructor(
    @Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  /**
   * `userIdDelProveedor` es null para quien no es proveedor (pareja, planner,
   * admin): `mine` sale null y no se consulta `pendientesDe`. Lo decide el
   * controlador según el acceso, no este caso de uso.
   */
  async estado(
    eventId: string,
    userIdDelProveedor: string | null,
  ): Promise<EstadoDeConfirmaciones> {
    const vendors = await this.items.estadoConfirmaciones(eventId)
    const mine =
      userIdDelProveedor === null
        ? null
        : { pending: await this.items.pendientesDe(eventId, userIdDelProveedor) }
    return { ready: vendors.filter((v) => v.ready).length, total: vendors.length, vendors, mine }
  }

  /**
   * Confirma lo que el proveedor tenía delante (`vistos`): una asignación
   * cuyo ítem cambió de hora entre medias queda pendiente (spec 2026-11-10
   * §4). `bloquearItems` antes de `confirmar` es lo que hace cierta esa regla
   * bajo concurrencia: si el planner está cambiando la hora, esta transacción
   * espera a su commit y el UPDATE de `confirmar` ya compara con la hora
   * nueva. Devuelve el estado tras confirmar, con `mine` del proveedor.
   */
  async confirmar(
    eventId: string,
    userId: string,
    vistos: PendienteDeProveedor[],
  ): Promise<EstadoDeConfirmaciones> {
    await this.unidadDeTrabajo.ejecutar(async () => {
      await this.items.bloquearItems(eventId, [...new Set(vistos.map((v) => v.itemId))])
      await this.items.confirmar(eventId, userId, vistos)
    })
    return await this.estado(eventId, userId)
  }
}

/**
 * "Notify Vendors" (spec 2026-11-10 §6): una campana
 * `schedule.confirmation.requested` por proveedor con alguna asignación
 * vigente sin confirmar. Sólo el planner. Sin pendientes no escribe ni encola
 * nada y responde `{ notified: 0 }` (la pantalla lo dice). Las filas se crean
 * en la transacción; el empuje en vivo, tras el commit. El límite de ritmo es
 * de la ruta (`@LimiteDeRuta('schedule-notify')`), no de aquí.
 */
@Injectable()
export class AvisarProveedoresUseCase {
  private readonly registro = new Logger(AvisarProveedoresUseCase.name)

  constructor(
    @Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(eventId: string, actor: ActorDelCronograma): Promise<{ notified: number }> {
    exigirPlanner(actor)
    const avisados = await this.unidadDeTrabajo.ejecutar(async () => {
      const usuarios = await this.items.usuariosConPendientes(eventId)
      if (usuarios.length > 0) {
        await this.notificaciones.crearParaUsuarios(
          eventId,
          usuarios,
          TIPO_CRONOGRAMA_CONFIRMACION,
          {},
        )
      }
      return usuarios
    })
    if (avisados.length > 0) {
      await encolarCampana(this.cola, this.registro, {
        eventId,
        tipo: TIPO_CRONOGRAMA_CONFIRMACION,
        userIds: avisados,
      })
    }
    return { notified: avisados.length }
  }
}
