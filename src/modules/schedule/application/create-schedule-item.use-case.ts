import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import {
  CambioDeEstadoNoPermitidoError,
  ItemDeCronogramaNoEncontradoError,
  RangoDeCronogramaInvalidoError,
  SoloPlannerError,
} from '../domain/schedule-errors'
import { rangoValido } from '../domain/schedule-item'
import { encolarRecordatorios } from './avisos-cronograma'
import { exigirAsignables } from './participacion.use-cases'
import {
  type DatosNuevoItem,
  type ItemConAsignaciones,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'
import type { ActorDelCronograma } from './update-schedule-item.use-case'

export type EntradaNuevoItem = Omit<DatosNuevoItem, 'eventId' | 'status'> & {
  status?: DatosNuevoItem['status'] | undefined
}

@Injectable()
export class CreateScheduleItemUseCase {
  private readonly registro = new Logger(CreateScheduleItemUseCase.name)

  constructor(
    @Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  /**
   * Quien no es planner sí crea ítems, pero sólo en PENDING (el de por
   * defecto): crear uno ya en DONE es cambiarle el estado por otra puerta.
   * Mandar `PENDING` explícito se acepta porque no decide nada.
   *
   * `eventVendorIds` (spec 2026-11-10 §3) es sólo del planner: con él presente
   * —aunque sea `[]`— quien no lo es recibe 403 `SCHEDULE_PLANNER_ONLY`, no un
   * ítem creado sin proveedores que el cliente creería asignado. Los ids se
   * validan contra `listarAsignables` ANTES de crear el ítem: un 422 no deja
   * un ítem huérfano ni con el doble de unidad de trabajo, que no deshace.
   * Crear y asignar van en la misma transacción; las asignaciones nacen sin
   * confirmar y, tras el commit, cada una programa su recordatorio. No hay
   * campana de "te asignaron" (spec §4: para eso está "Notify Vendors").
   */
  async ejecutar(
    eventId: string,
    entrada: EntradaNuevoItem,
    actor: ActorDelCronograma,
    eventVendorIds?: string[],
  ): Promise<ItemConAsignaciones> {
    const status = entrada.status ?? 'PENDING'
    if (status !== 'PENDING' && !actor.esPlanner) throw new CambioDeEstadoNoPermitidoError()
    if (!rangoValido(entrada.startsAt, entrada.endsAt)) throw new RangoDeCronogramaInvalidoError()
    if (eventVendorIds !== undefined && !actor.esPlanner) throw new SoloPlannerError()

    const { item, altas } = await this.unidadDeTrabajo.ejecutar(async () => {
      const pedidos = eventVendorIds ?? []
      await exigirAsignables(this.items, eventId, pedidos)
      const creado = await this.items.crear({ ...entrada, eventId, status })
      const { altas } =
        pedidos.length > 0
          ? await this.items.fijarAsignaciones(creado.id, pedidos, actor.userId)
          : { altas: [] }
      const item = await this.items.buscarConAsignaciones(eventId, creado.id)
      if (item === null) throw new ItemDeCronogramaNoEncontradoError()
      return { item, altas }
    })

    await encolarRecordatorios(
      this.cola,
      this.registro,
      altas.map((eventVendorId) => ({ itemId: item.id, eventVendorId, startsAt: item.startsAt })),
      new Date(),
    )
    return item
  }
}
