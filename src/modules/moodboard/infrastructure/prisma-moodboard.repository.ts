import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'

import type {
  ContratacionCompartible,
  DatosNuevaImagen,
  ImagenDeMoodboard,
  MoodboardRepository,
} from '../application/moodboard.repository'
import type { Visor } from '../domain/moodboard'

const porTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const INCLUIR = {
  category: { select: { id: true, slug: true, name: true } },
  uploadedBy: { select: { id: true, fullName: true } },
  shares: {
    where: { revokedAt: null },
    select: {
      eventVendorId: true,
      eventVendor: {
        select: { externalName: true, vendorProfile: { select: { businessName: true } } },
      },
    },
  },
  _count: { select: { notes: true } },
} satisfies Prisma.MoodboardImageInclude

type FilaImagen = Prisma.MoodboardImageGetPayload<{ include: typeof INCLUIR }>

/**
 * Adaptador Prisma del puerto. La visibilidad de proveedor se expresa UNA vez
 * (`filtroDeVisor`) y la usan listado y búsqueda, para que no puedan divergir.
 * TODA lectura y escritura va por `clienteDe(this.prisma)` (no-op fuera de una
 * transacción): dentro de una unidad de trabajo, `proveedoresQueVen` tras
 * `fijarComparticion` debe ver lo recién escrito sin confirmar. Alternativa
 * descartada: leer con `this.prisma`, que usa otra conexión y no lo vería.
 * `bloquearYContar` y
 * `crearImagen` corren en la misma transacción que abre el caso de uso.
 */
@Injectable()
export class PrismaMoodboardRepository implements MoodboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  async bloquearYContar(eventId: string): Promise<number> {
    const cliente = clienteDe(this.prisma)
    // `$queryRaw` con template tag: el id va como parámetro, nada se concatena.
    await cliente.$queryRaw`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`
    return await cliente.moodboardImage.count({ where: { eventId } })
  }

  async categoriaActiva(categoryId: string): Promise<boolean> {
    const categoria = await clienteDe(this.prisma).vendorCategory.findUnique({
      where: { id: categoryId },
      select: { active: true },
    })
    return categoria?.active === true
  }

  async crearImagen(datos: DatosNuevaImagen): Promise<ImagenDeMoodboard> {
    const fila = await clienteDe(this.prisma).moodboardImage.create({
      data: datos,
      include: INCLUIR,
    })
    return this.proyectar(fila)
  }

  async listarImagenes(
    eventId: string,
    visor: Visor,
    archivadas: boolean,
  ): Promise<ImagenDeMoodboard[]> {
    if (visor.tipo === 'proveedor' && archivadas) return []
    const filas = await clienteDe(this.prisma).moodboardImage.findMany({
      where: {
        eventId,
        archivedAt: archivadas ? { not: null } : null,
        ...this.filtroDeVisor(eventId, visor),
      },
      include: INCLUIR,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    return filas.map((f) => this.proyectar(f))
  }

  async buscarImagen(
    eventId: string,
    imageId: string,
    visor: Visor,
  ): Promise<ImagenDeMoodboard | null> {
    const fila = await clienteDe(this.prisma).moodboardImage.findFirst({
      where: { id: imageId, eventId, ...this.filtroDeVisor(eventId, visor) },
      include: INCLUIR,
    })
    return fila === null ? null : this.proyectar(fila)
  }

  async fijarArchivo(imageId: string, por: string | null): Promise<void> {
    await clienteDe(this.prisma).moodboardImage.update({
      where: { id: imageId },
      data:
        por === null
          ? { archivedAt: null, archivedById: null }
          : { archivedAt: new Date(), archivedById: por },
    })
  }

  async listarCompartibles(eventId: string): Promise<ContratacionCompartible[]> {
    const filas = await clienteDe(this.prisma).eventVendor.findMany({
      where: { eventId, status: 'BOOKED', vendorProfileId: { not: null } },
      select: {
        id: true,
        category: { select: { name: true } },
        vendorProfile: { select: { businessName: true, userId: true } },
      },
    })
    const lista: ContratacionCompartible[] = []
    for (const f of filas) {
      if (f.vendorProfile === null) continue
      lista.push({
        eventVendorId: f.id,
        name: f.vendorProfile.businessName,
        categoryName: f.category.name,
        userId: f.vendorProfile.userId,
      })
    }
    return lista.sort(
      (a, b) => porTexto(a.name, b.name) || porTexto(a.eventVendorId, b.eventVendorId),
    )
  }

  async fijarComparticion(
    imageId: string,
    eventVendorIds: string[],
    por: string,
  ): Promise<{ altas: string[]; bajas: string[] }> {
    const cliente = clienteDe(this.prisma)
    const vigentes = await cliente.moodboardShare.findMany({
      where: { imageId, revokedAt: null },
      select: { eventVendorId: true },
    })
    const vigentesIds = new Set(vigentes.map((s) => s.eventVendorId))
    const pedidos = new Set(eventVendorIds)
    const altas = [...pedidos].filter((id) => !vigentesIds.has(id)).sort(porTexto)
    const bajas = [...vigentesIds].filter((id) => !pedidos.has(id)).sort(porTexto)
    for (const eventVendorId of altas) {
      // Reaviva la fila si existió: el UNIQUE (imageId, eventVendorId) sigue intacto.
      await cliente.moodboardShare.upsert({
        where: { imageId_eventVendorId: { imageId, eventVendorId } },
        create: { imageId, eventVendorId, sharedById: por },
        update: { revokedAt: null, sharedById: por },
      })
    }
    if (bajas.length > 0) {
      await cliente.moodboardShare.updateMany({
        where: { imageId, eventVendorId: { in: bajas }, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }
    return { altas, bajas }
  }

  async usuariosDeContrataciones(eventVendorIds: string[]): Promise<string[]> {
    const filas = await clienteDe(this.prisma).eventVendor.findMany({
      where: { id: { in: eventVendorIds }, vendorProfileId: { not: null } },
      select: { vendorProfile: { select: { userId: true } } },
    })
    return [
      ...new Set(filas.flatMap((f) => (f.vendorProfile === null ? [] : [f.vendorProfile.userId]))),
    ]
  }

  async proveedoresQueVen(imageId: string): Promise<string[]> {
    const filas = await clienteDe(this.prisma).moodboardShare.findMany({
      where: {
        imageId,
        revokedAt: null,
        image: { archivedAt: null, event: { status: 'ACTIVE' } },
        eventVendor: { status: 'BOOKED', vendorProfileId: { not: null } },
      },
      select: {
        eventVendor: { select: { eventId: true, vendorProfile: { select: { userId: true } } } },
        image: { select: { eventId: true } },
      },
    })
    const usuarios = new Set<string>()
    for (const f of filas) {
      if (f.eventVendor.eventId === f.image.eventId && f.eventVendor.vendorProfile !== null) {
        usuarios.add(f.eventVendor.vendorProfile.userId)
      }
    }
    return [...usuarios]
  }

  /**
   * Miembro: sin filtro. Proveedor: foto activa, evento ACTIVE y alguna
   * compartición vigente cuya contratación sea BOOKED, de este evento y suya.
   */
  private filtroDeVisor(eventId: string, visor: Visor): Prisma.MoodboardImageWhereInput {
    if (visor.tipo === 'miembro') return {}
    return {
      archivedAt: null,
      event: { status: 'ACTIVE' },
      shares: {
        some: {
          revokedAt: null,
          eventVendor: {
            status: 'BOOKED',
            eventId,
            vendorProfile: { userId: visor.userId },
          },
        },
      },
    }
  }

  private proyectar(f: FilaImagen): ImagenDeMoodboard {
    return {
      id: f.id,
      eventId: f.eventId,
      title: f.title,
      storageKey: f.storageKey,
      width: f.width,
      height: f.height,
      category: f.category,
      uploadedBy: { id: f.uploadedBy.id, name: f.uploadedBy.fullName },
      createdAt: f.createdAt,
      archivedAt: f.archivedAt,
      noteCount: f._count.notes,
      sharedWith: f.shares
        .map((s) => ({
          eventVendorId: s.eventVendorId,
          name: s.eventVendor.vendorProfile?.businessName ?? s.eventVendor.externalName ?? '',
        }))
        .sort((a, b) => porTexto(a.name, b.name) || porTexto(a.eventVendorId, b.eventVendorId)),
    }
  }
}
