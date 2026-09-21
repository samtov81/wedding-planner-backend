import { randomUUID } from 'node:crypto'

import type {
  CambiosEventVendor,
  DatosCrearEventVendor,
  EventVendorRepository,
  EventVendorVista,
} from '../application/event-vendor.repository'
import type { VendorRef } from '../domain/vendor-ref'

export interface PerfilPublicadoEnMemoria {
  id: string
  status: 'DRAFT' | 'PUBLISHED' | 'SUSPENDED'
}

interface FilaEnMemoria {
  id: string
  eventId: string
  vendorRef: VendorRef
  category: string
  specialty: string | null
  assignedBudget: number | null
  status: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'
  createdAt: Date
  updatedAt: Date
}

export interface AuditoriaVendorEnMemoria {
  actorUserId: string
  eventId: string
  action: string
  target: string
}

/**
 * Doble en memoria del puerto (ruling H1: vive junto a él). Los perfiles del
 * marketplace se siembran aparte porque este módulo no gestiona `VendorProfile`
 * —está fuera de alcance—, sólo necesita SABER si uno está publicado.
 */
export class EventVendorRepositoryEnMemoria implements EventVendorRepository {
  readonly filas: FilaEnMemoria[] = []
  readonly perfiles: PerfilPublicadoEnMemoria[] = []
  readonly auditoria: AuditoriaVendorEnMemoria[] = []

  buscarPerfilPublicado(vendorProfileId: string): Promise<{ id: string } | null> {
    const perfil = this.perfiles.find((p) => p.id === vendorProfileId && p.status === 'PUBLISHED')
    return Promise.resolve(perfil === undefined ? null : { id: perfil.id })
  }

  crear(datos: DatosCrearEventVendor): Promise<EventVendorVista> {
    const fila: FilaEnMemoria = {
      id: randomUUID(),
      eventId: datos.eventId,
      vendorRef: datos.vendorRef,
      category: datos.category,
      specialty: datos.specialty,
      assignedBudget: datos.assignedBudget,
      status: 'SHORTLISTED',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }
    this.filas.push(fila)
    this.auditoria.push({
      actorUserId: datos.actorUserId,
      eventId: datos.eventId,
      action: 'event_vendor.added',
      target: `event_vendor:${fila.id}`,
    })
    return Promise.resolve(this.aVista(fila))
  }

  listarPorEvento(eventId: string): Promise<EventVendorVista[]> {
    return Promise.resolve(
      this.filas.filter((f) => f.eventId === eventId).map((f) => this.aVista(f)),
    )
  }

  buscarPorId(eventId: string, eventVendorId: string): Promise<EventVendorVista | null> {
    const fila = this.filas.find((f) => f.id === eventVendorId && f.eventId === eventId)
    return Promise.resolve(fila === undefined ? null : this.aVista(fila))
  }

  actualizar(
    eventId: string,
    eventVendorId: string,
    cambios: CambiosEventVendor,
    actorUserId: string,
  ): Promise<EventVendorVista> {
    const fila = this.filas.find((f) => f.id === eventVendorId && f.eventId === eventId)
    if (fila === undefined) throw new Error('fila inexistente en el doble en memoria')
    if (cambios.category !== undefined) fila.category = cambios.category
    if (cambios.specialty !== undefined) fila.specialty = cambios.specialty
    if (cambios.assignedBudget !== undefined) fila.assignedBudget = cambios.assignedBudget
    if (cambios.status !== undefined) fila.status = cambios.status
    fila.updatedAt = new Date('2026-01-02T00:00:00.000Z')
    this.auditoria.push({
      actorUserId,
      eventId,
      action: 'event_vendor.updated',
      target: `event_vendor:${eventVendorId}`,
    })
    return Promise.resolve(this.aVista(fila))
  }

  eliminar(eventId: string, eventVendorId: string, actorUserId: string): Promise<void> {
    const indice = this.filas.findIndex((f) => f.id === eventVendorId && f.eventId === eventId)
    if (indice !== -1) this.filas.splice(indice, 1)
    this.auditoria.push({
      actorUserId,
      eventId,
      action: 'event_vendor.removed',
      target: `event_vendor:${eventVendorId}`,
    })
    return Promise.resolve()
  }

  private aVista(fila: FilaEnMemoria): EventVendorVista {
    return { ...fila }
  }
}
