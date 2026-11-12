import { Inject, Injectable } from '@nestjs/common'

import { accesoAlPresupuesto, type EventAccess } from '../domain/event-access'
import { EVENT_REPOSITORY, type EventRepository } from './event.repository'

/**
 * PUNTO ÚNICO DE AUTORIZACIÓN sobre un evento. El acceso tiene dos fuentes
 * (`EventMembership` y `EventVendor`) y, repartida por los controladores, una
 * de las dos se olvida en algún endpoint. Concentrarla además hace que el
 * mismo código autorice REST y sockets (Tarea 14), así que los permisos del
 * tiempo real no pueden divergir de los del HTTP.
 */
@Injectable()
export class EventAccessService {
  constructor(@Inject(EVENT_REPOSITORY) private readonly repo: EventRepository) {}

  async resolve(
    userId: string,
    systemRole: 'USER' | 'ADMIN',
    eventId: string,
  ): Promise<EventAccess> {
    if (systemRole === 'ADMIN') return { kind: 'admin' }

    const membresia = await this.repo.buscarMembresiaActiva(eventId, userId)
    if (membresia !== null) {
      return {
        kind: 'member',
        role: membresia.role,
        owner: membresia.owner,
        budgetView: membresia.budgetView,
      }
    }

    // Sólo BOOKED, y sólo con ficha enlazada: un EventVendor externo no tiene
    // cuenta detrás, así que no puede conceder acceso a ningún usuario.
    const contratacion = await this.repo.buscarContratacionReservada(eventId, userId)
    if (contratacion !== null) return { kind: 'vendor', eventVendorId: contratacion.id }

    return { kind: 'none' }
  }

  /**
   * Los `userId` de los miembros ACTIVE que ven el presupuesto del evento: los
   * destinatarios de `expense.changed` (spec 2026-11-11 §9). Aplica
   * `accesoAlPresupuesto`, la regla única, a cada miembro en vez de repetir
   * "owner o grant" en el worker de `expenses`; la alternativa descartada era
   * que ese worker consultara grants por su cuenta y la regla divergiera.
   * No incluye admins: no son miembros y entran por la sala del evento.
   */
  async usuariosConPresupuesto(eventId: string): Promise<string[]> {
    const miembros = await this.repo.listarMiembros(eventId)
    return miembros
      .filter(
        (m) =>
          m.status === 'ACTIVE' &&
          accesoAlPresupuesto({
            kind: 'member',
            role: m.role,
            owner: m.owner,
            budgetView: m.budgetView,
          }) !== 'none',
      )
      .map((m) => m.userId)
  }
}
