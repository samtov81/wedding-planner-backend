import { Inject, Injectable } from '@nestjs/common'

import type { EventAccess } from '../domain/event-access'
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
    if (membresia !== null) return { kind: 'member', role: membresia.role }

    // Sólo BOOKED, y sólo con ficha enlazada: un EventVendor externo no tiene
    // cuenta detrás, así que no puede conceder acceso a ningún usuario.
    const contratacion = await this.repo.buscarContratacionReservada(eventId, userId)
    if (contratacion !== null) return { kind: 'vendor', eventVendorId: contratacion.id }

    return { kind: 'none' }
  }
}
