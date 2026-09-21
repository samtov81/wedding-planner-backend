import { Injectable } from '@nestjs/common'
import type { EventVendor as EventVendorFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'

import type {
  CambiosEventVendor,
  DatosCrearEventVendor,
  EventVendorRepository,
  EventVendorVista,
} from '../application/event-vendor.repository'
import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import type { VendorRef } from '../domain/vendor-ref'

@Injectable()
export class PrismaEventVendorRepository implements EventVendorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscarPerfilPublicado(vendorProfileId: string): Promise<{ id: string } | null> {
    const fila = await this.prisma.vendorProfile.findFirst({
      where: { id: vendorProfileId, status: 'PUBLISHED' },
      select: { id: true },
    })
    return fila === null ? null : { id: fila.id }
  }

  async crear(datos: DatosCrearEventVendor): Promise<EventVendorVista> {
    return await this.prisma.$transaction(async (tx) => {
      const fila = await tx.eventVendor.create({
        data: {
          eventId: datos.eventId,
          category: datos.category,
          specialty: datos.specialty,
          assignedBudget: datos.assignedBudget,
          ...(datos.vendorRef.kind === 'linked'
            ? { vendorProfileId: datos.vendorRef.vendorProfileId }
            : {
                externalName: datos.vendorRef.name,
                externalEmail: datos.vendorRef.email,
                externalPhone: datos.vendorRef.phone,
              }),
        },
      })

      await tx.auditLog.create({
        data: {
          actorUserId: datos.actorUserId,
          eventId: datos.eventId,
          action: 'event_vendor.added',
          target: `event_vendor:${fila.id}`,
          // Sin nombre, email ni teléfono: `vendorRef` completo (rama
          // `external`) los lleva en claro. `kind` y `vendorProfileId` (sólo
          // en la rama `linked`, donde no hay dato personal) bastan para
          // auditar QUÉ se dio de alta sin guardar quién es la persona.
          metadata: {
            kind: datos.vendorRef.kind,
            ...(datos.vendorRef.kind === 'linked'
              ? { vendorProfileId: datos.vendorRef.vendorProfileId }
              : {}),
          },
        },
      })

      return this.aVista(fila)
    })
  }

  async listarPorEvento(eventId: string): Promise<EventVendorVista[]> {
    const filas = await this.prisma.eventVendor.findMany({
      where: { eventId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map((fila) => this.aVista(fila))
  }

  async buscarPorId(eventId: string, eventVendorId: string): Promise<EventVendorVista | null> {
    const fila = await this.prisma.eventVendor.findFirst({ where: { id: eventVendorId, eventId } })
    return fila === null ? null : this.aVista(fila)
  }

  // `this.prisma.$transaction`, no `clienteDe(this.prisma)`: este módulo no
  // está enganchado a `UnidadDeTrabajo` en ningún caso de uso (ni el propio ni
  // de otro módulo importa `EventVendorRepository`), así que `actualizar` y
  // `eliminar` nunca corren dentro de una transacción ajena que anidar. Es la
  // misma forma que ya usa `crear` para su `AuditLog`.
  async actualizar(
    eventId: string,
    eventVendorId: string,
    cambios: CambiosEventVendor,
    actorUserId: string,
  ): Promise<EventVendorVista> {
    return await this.prisma.$transaction(async (tx) => {
      // `updateMany` + relectura, no `update`: `update` exige una clave única
      // (`id`), y con sólo `id` no se comprueba que la fila sea de ESTE
      // evento. El caso de uso ya comprobó existencia con `buscarPorId`, pero
      // repetir el filtro aquí evita que una futura llamada directa al
      // repositorio la salte.
      await tx.eventVendor.updateMany({
        where: { id: eventVendorId, eventId },
        data: {
          ...(cambios.category !== undefined ? { category: cambios.category } : {}),
          ...(cambios.specialty !== undefined ? { specialty: cambios.specialty } : {}),
          ...(cambios.assignedBudget !== undefined
            ? { assignedBudget: cambios.assignedBudget }
            : {}),
          ...(cambios.status !== undefined ? { status: cambios.status } : {}),
        },
      })
      // `findFirst`, no `findFirstOrThrow`: si la fila desapareció ENTRE el
      // `updateMany` y esta relectura (borrado concurrente), lanzar un P2025
      // crudo sería un 500. El caso de uso ya comprobó que existía antes de
      // escribir; aquí se repite el mismo 404 de dominio para la ventana
      // entre medias. Al lanzar dentro de la transacción, Prisma la deshace:
      // no queda un `AuditLog` de un cambio que nunca se leyó de vuelta.
      const fila = await tx.eventVendor.findFirst({
        where: { id: eventVendorId, eventId },
      })
      if (fila === null) throw new EventVendorNoEncontradoError()

      await tx.auditLog.create({
        data: {
          actorUserId,
          eventId,
          action: 'event_vendor.updated',
          target: `event_vendor:${eventVendorId}`,
          // Sin datos personales: sólo QUÉ campos cambiaron, nunca su valor
          // (`category`/`specialty` son texto libre y podrían llevarlos).
          metadata: { eventVendorId, campos: Object.keys(cambios) },
        },
      })

      return this.aVista(fila)
    })
  }

  async eliminar(eventId: string, eventVendorId: string, actorUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.eventVendor.deleteMany({ where: { id: eventVendorId, eventId } })
      await tx.auditLog.create({
        data: {
          actorUserId,
          eventId,
          action: 'event_vendor.removed',
          target: `event_vendor:${eventVendorId}`,
          metadata: { eventVendorId },
        },
      })
    })
  }

  /** La fila de Prisma no sale de infrastructure/: reconstruye el `VendorRef`. */
  private aVista(fila: EventVendorFila): EventVendorVista {
    const vendorRef: VendorRef =
      fila.vendorProfileId !== null
        ? { kind: 'linked', vendorProfileId: fila.vendorProfileId }
        : {
            kind: 'external',
            name: fila.externalName ?? '',
            email: fila.externalEmail,
            phone: fila.externalPhone,
          }

    return {
      id: fila.id,
      eventId: fila.eventId,
      vendorRef,
      category: fila.category,
      specialty: fila.specialty,
      assignedBudget: fila.assignedBudget === null ? null : Number(fila.assignedBudget),
      status: fila.status,
      createdAt: fila.createdAt,
      updatedAt: fila.updatedAt,
    }
  }
}
