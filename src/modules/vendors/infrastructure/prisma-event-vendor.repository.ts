import { Injectable } from '@nestjs/common'
import type { EventVendor as EventVendorFila } from '@prisma/client'

import { PrismaService } from '@/modules/database/prisma.service'
import { enTransaccion } from '@/modules/database/transaccion'

import type {
  CambiosEventVendor,
  DatosCrearEventVendor,
  EventVendorRepository,
  EventVendorVista,
  ResultadoActualizacion,
} from '../application/event-vendor.repository'
import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import type { VendorRef } from '../domain/vendor-ref'

/** Lo que `aVista` necesita de cada fila. */
const INCLUIR = {
  vendorProfile: { select: { businessName: true, userId: true } },
  category: { select: { slug: true, name: true } },
} as const

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
          categoryId: datos.category.id,
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
        include: INCLUIR,
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
      include: INCLUIR,
    })
    return filas.map((fila) => this.aVista(fila))
  }

  async buscarPorId(eventId: string, eventVendorId: string): Promise<EventVendorVista | null> {
    const fila = await this.prisma.eventVendor.findFirst({
      where: { id: eventVendorId, eventId },
      include: INCLUIR,
    })
    return fila === null ? null : this.aVista(fila)
  }

  // `enTransaccion`: `UpdateEventVendorUseCase` abre una unidad de trabajo para
  // que el cambio de estado y el aviso al proveedor se confirmen juntos, así
  // que `actualizar` se UNE a ella; sin unidad en curso abre la suya.
  //
  // El paso a `BOOKED` es una escritura CONDICIONADA (`status <> 'BOOKED'`) y
  // su `count` decide si hubo transición (ver `ResultadoActualizacion`).
  // Alternativa descartada: leer el estado antes y comparar; dos PATCH
  // concurrentes verían ambos `SHORTLISTED` y avisarían dos veces.
  async actualizar(
    eventId: string,
    eventVendorId: string,
    cambios: CambiosEventVendor,
    actorUserId: string,
  ): Promise<ResultadoActualizacion> {
    return await enTransaccion(this.prisma, async (tx) => {
      // `updateMany` + relectura, no `update`: `update` exige una clave única
      // (`id`), y con sólo `id` no se comprueba que la fila sea de ESTE
      // evento. El caso de uso ya comprobó existencia con `buscarPorId`, pero
      // repetir el filtro aquí evita que una futura llamada directa al
      // repositorio la salte.
      const { status, ...otros } = cambios
      await tx.eventVendor.updateMany({
        where: { id: eventVendorId, eventId },
        data: {
          ...(otros.category !== undefined ? { categoryId: otros.category.id } : {}),
          ...(otros.specialty !== undefined ? { specialty: otros.specialty } : {}),
          ...(otros.assignedBudget !== undefined ? { assignedBudget: otros.assignedBudget } : {}),
          // `BOOKED` va aparte, condicionado; cualquier otro estado, sin condición.
          ...(status !== undefined && status !== 'BOOKED' ? { status } : {}),
        },
      })
      const transicion =
        status === 'BOOKED'
          ? (
              await tx.eventVendor.updateMany({
                where: { id: eventVendorId, eventId, status: { not: 'BOOKED' } },
                data: { status: 'BOOKED' },
              })
            ).count === 1
          : false
      // `findFirst`, no `findFirstOrThrow`: si la fila desapareció ENTRE el
      // `updateMany` y esta relectura (borrado concurrente), lanzar un P2025
      // crudo sería un 500. El caso de uso ya comprobó que existía antes de
      // escribir; aquí se repite el mismo 404 de dominio para la ventana
      // entre medias. Al lanzar dentro de la transacción, Prisma la deshace:
      // no queda un `AuditLog` de un cambio que nunca se leyó de vuelta.
      const fila = await tx.eventVendor.findFirst({
        where: { id: eventVendorId, eventId },
        include: INCLUIR,
      })
      if (fila === null) throw new EventVendorNoEncontradoError()

      await tx.auditLog.create({
        data: {
          actorUserId,
          eventId,
          action: 'event_vendor.updated',
          target: `event_vendor:${eventVendorId}`,
          // Sin datos personales: sólo QUÉ campos cambiaron, nunca su valor
          // (`specialty` es texto libre y podría llevarlos).
          metadata: { eventVendorId, campos: Object.keys(cambios) },
        },
      })

      return {
        vista: this.aVista(fila),
        contratado: transicion ? { proveedorUserId: fila.vendorProfile?.userId ?? null } : null,
      }
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

  async tieneGastos(eventId: string, eventVendorId: string): Promise<boolean> {
    const n = await this.prisma.expense.count({ where: { eventId, eventVendorId } })
    return n > 0
  }

  /** La fila de Prisma no sale de infrastructure/: reconstruye el `VendorRef`. */
  private aVista(
    fila: EventVendorFila & {
      vendorProfile: { businessName: string; userId: string } | null
      category: { slug: string; name: string }
    },
  ): EventVendorVista {
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
      category: { slug: fila.category.slug, name: fila.category.name },
      specialty: fila.specialty,
      assignedBudget: fila.assignedBudget === null ? null : fila.assignedBudget.toFixed(2),
      name: fila.vendorProfile?.businessName ?? fila.externalName ?? '',
      status: fila.status,
      createdAt: fila.createdAt,
      updatedAt: fila.updatedAt,
    }
  }
}
