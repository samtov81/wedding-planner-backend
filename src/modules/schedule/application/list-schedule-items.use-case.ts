import { Inject, Injectable } from '@nestjs/common'

import {
  type ItemConAsignaciones,
  SCHEDULE_ITEM_REPOSITORY,
  type ScheduleItemRepository,
} from './schedule-item.repository'

/** Un ítem del listado. `noteCount` existe SÓLO en el listado del planner. */
export interface ItemDelListado extends ItemConAsignaciones {
  noteCount?: number
}

@Injectable()
export class ListScheduleItemsUseCase {
  constructor(@Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository) {}

  /**
   * Todos ven los proveedores asignados (vigentes) de cada ítem; el número de
   * notas, sólo el planner (spec 2026-11-10 §3, §7). Para los demás la
   * propiedad NO EXISTE —no vale `0` ni `undefined`—: las notas "no existen"
   * para ellos y un contador a cero ya diría que el concepto está ahí. Ni
   * siquiera se consulta `contarNotas`. Para el planner, un ítem sin notas
   * lleva `0`.
   */
  async ejecutar(eventId: string, esPlanner: boolean): Promise<ItemDelListado[]> {
    const items = await this.items.listarConAsignaciones(eventId)
    if (!esPlanner) return items
    const cuentas = await this.items.contarNotas(eventId)
    return items.map((i) => ({ ...i, noteCount: cuentas.get(i.id) ?? 0 }))
  }
}
