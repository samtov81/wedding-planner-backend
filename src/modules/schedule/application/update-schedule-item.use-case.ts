import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
  TIPO_CRONOGRAMA_REPROGRAMADO,
} from '@/modules/notifications/application/notification.port'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { cambiaLaHora } from '../domain/participacion'
import {
  CambioDeEstadoNoPermitidoError,
  ItemDeCronogramaNoEncontradoError,
  RangoDeCronogramaInvalidoError,
} from '../domain/schedule-errors'
import { rangoValido } from '../domain/schedule-item'
import { encolarCampana, encolarRecordatorios } from './avisos-cronograma'
import {
  type CambiosItem,
  type ItemConAsignaciones,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'

/**
 * Lo que los casos de uso del cronograma necesitan saber de quien escribe. Lo
 * construye el controlador: `esPlanner = esPlannerDelEvento(acceso)` (events/
 * domain), así la regla de "quién es planner" vive allí una sola vez y aquí
 * llega ya decidida, sin que el cronograma conozca roles.
 *
 * `esPlanner` gobierna a la vez el estado del ítem (lo que antes era
 * `puedeCambiarEstado`, calculado con `puedeCambiarEstadoDelCronograma`, ya
 * borrada por ser exactamente `esPlannerDelEvento`), las asignaciones, las notas y "Notify Vendors" (spec
 * 2026-11-10 §3). Alternativa descartada: conservar `puedeCambiarEstado` junto
 * a `esPlanner`, dos booleanos que hoy significan lo mismo y que el
 * controlador podría desalinear. Ambos campos son obligatorios a propósito:
 * olvidarlos no compila, en vez de abrir permisos por defecto.
 */
export interface ActorDelCronograma {
  userId: string
  esPlanner: boolean
}

@Injectable()
export class UpdateScheduleItemUseCase {
  private readonly registro = new Logger(UpdateScheduleItemUseCase.name)

  constructor(
    @Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(NOTIFICATION_PORT) private readonly notificaciones: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  /**
   * El rango se valida contra lo guardado: un PATCH puede traer solo el fin.
   *
   * Un `status` en el cuerpo de quien no es planner es 403 aunque coincida con
   * el guardado: el cliente no tiene por qué mandarlo (el formulario de edición
   * no lo envía), y aceptarlo "si no cambia nada" obligaría a leer antes de
   * decidir sin ganar nada.
   *
   * Reconfirmación (spec 2026-11-10 §4): si cambia `startsAt` o `endsAt`, en
   * la MISMA transacción se desconfirman todas las asignaciones del ítem y se
   * crea `schedule.item.rescheduled` para cada proveedor asignado (vigente).
   * Lo primero de la transacción es `bloquearItems`: un `confirmar`
   * concurrente espera a este commit y ya compara con la hora nueva. Se
   * bloquea SIEMPRE, no sólo si cambia la hora, porque saber si cambia exige
   * leer la hora guardada, y leerla antes del bloqueo es justo la carrera que
   * se quiere cerrar.
   *
   * Tras el commit: el empuje en vivo de la campana y un recordatorio por
   * asignación vigente con la hora NUEVA. El job de la hora vieja no se borra:
   * el worker lo descarta por no coincidir (spec §5).
   */
  async ejecutar(
    eventId: string,
    itemId: string,
    cambios: CambiosItem,
    actor: ActorDelCronograma,
  ): Promise<ItemConAsignaciones> {
    const { item, horaCambiada, avisados } = await this.unidadDeTrabajo.ejecutar(async () => {
      await this.items.bloquearItems(eventId, [itemId])
      const actual = await this.items.buscarPorId(eventId, itemId)
      if (actual === null) throw new ItemDeCronogramaNoEncontradoError()
      if (cambios.status !== undefined && !actor.esPlanner) {
        throw new CambioDeEstadoNoPermitidoError()
      }
      const startsAt = cambios.startsAt ?? actual.startsAt
      const endsAt = cambios.endsAt !== undefined ? cambios.endsAt : actual.endsAt
      if (!rangoValido(startsAt, endsAt)) throw new RangoDeCronogramaInvalidoError()

      const actualizado = await this.items.actualizar(eventId, itemId, cambios)
      const horaCambiada = cambiaLaHora(actual, cambios)
      let avisados: string[] = []
      if (horaCambiada) {
        await this.items.desconfirmarItem(itemId)
        avisados = await this.items.usuariosAsignados(itemId)
        if (avisados.length > 0) {
          await this.notificaciones.crearParaUsuarios(
            eventId,
            avisados,
            TIPO_CRONOGRAMA_REPROGRAMADO,
            { scheduleItemId: itemId, title: actualizado.title },
          )
        }
      }
      const item = await this.items.buscarConAsignaciones(eventId, itemId)
      if (item === null) throw new ItemDeCronogramaNoEncontradoError()
      return { item, horaCambiada, avisados }
    })

    if (avisados.length > 0) {
      await encolarCampana(this.cola, this.registro, {
        eventId,
        tipo: TIPO_CRONOGRAMA_REPROGRAMADO,
        userIds: avisados,
      })
    }
    if (horaCambiada) {
      await encolarRecordatorios(
        this.cola,
        this.registro,
        item.vendors.map((v) => ({
          itemId,
          eventVendorId: v.eventVendorId,
          startsAt: item.startsAt,
        })),
        new Date(),
      )
    }
    return item
  }
}
