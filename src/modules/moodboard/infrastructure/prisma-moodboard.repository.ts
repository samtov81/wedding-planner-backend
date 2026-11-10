import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'

import type {
  ActividadDeMoodboard,
  Colaborador,
  ContratacionCompartible,
  DatosNuevaImagen,
  ImagenDeMoodboard,
  MoodboardRepository,
  NotaDeMoodboard,
  ResumenCrudo,
} from '../application/moodboard.repository'
import type { Visor } from '../domain/moodboard'
import { SubidaYaUsadaError } from '../domain/moodboard-errors'

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

const INCLUIR_NOTA = {
  author: { select: { id: true, fullName: true, avatarKey: true } },
} satisfies Prisma.MoodboardNoteInclude

type FilaNota = Prisma.MoodboardNoteGetPayload<{ include: typeof INCLUIR_NOTA }>

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

  /** Ver el contrato en el puerto. Sin fila que bloquear no hace nada. */
  async bloquearImagen(eventId: string, imageId: string): Promise<void> {
    // `$queryRaw` con template tag: los ids van como parámetros, nada se concatena.
    await clienteDe(this.prisma).$queryRaw`
      SELECT id FROM moodboard_images
      WHERE id = ${imageId}::uuid AND "eventId" = ${eventId}::uuid
      FOR UPDATE`
  }

  async categoriaActivaPorSlug(slug: string): Promise<string | null> {
    const categoria = await clienteDe(this.prisma).vendorCategory.findUnique({
      where: { slug },
      select: { id: true, active: true },
    })
    return categoria?.active === true ? categoria.id : null
  }

  /**
   * `storageKey` es UNIQUE: reintentar el alta con la misma key choca (P2002)
   * y se traduce aquí, en la frontera, a `SubidaYaUsadaError` (409), para que
   * el caso de uso no conozca códigos de Prisma. Capturar el P2002 deja la
   * transacción abortada, pero es la última sentencia de la unidad de trabajo:
   * el error sube y la unidad hace rollback, sin nada más que escribir.
   * Alternativa descartada: buscar la key antes de insertar, que añade una
   * consulta por alta para un caso raro y sigue necesitando la captura.
   */
  async crearImagen(datos: DatosNuevaImagen): Promise<ImagenDeMoodboard> {
    try {
      const fila = await clienteDe(this.prisma).moodboardImage.create({
        data: datos,
        include: INCLUIR,
      })
      return this.proyectar(fila)
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new SubidaYaUsadaError()
      }
      throw error
    }
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
    const filas = await this.comparticionesQueVen({ id: imageId })
    return [...new Set(filas.map((f) => f.userId))]
  }

  async listarNotas(imageId: string): Promise<NotaDeMoodboard[]> {
    const filas = await clienteDe(this.prisma).moodboardNote.findMany({
      where: { imageId },
      include: INCLUIR_NOTA,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    return filas.map((f) => this.proyectarNota(f))
  }

  async crearNota(imageId: string, authorId: string, body: string): Promise<NotaDeMoodboard> {
    const fila = await clienteDe(this.prisma).moodboardNote.create({
      data: { imageId, authorId, body },
      include: INCLUIR_NOTA,
    })
    return this.proyectarNota(fila)
  }

  async resumen(eventId: string, visor: Visor): Promise<ResumenCrudo> {
    const cliente = clienteDe(this.prisma)
    // Las fotos que el visor ve: la misma regla que listado y búsqueda.
    const fotos: Prisma.MoodboardImageWhereInput = {
      eventId,
      archivedAt: null,
      ...this.filtroDeVisor(eventId, visor),
    }
    const [images, notes, fotosRecientes, notasRecientes, miembros, proveedores] =
      await Promise.all([
        cliente.moodboardImage.count({ where: fotos }),
        cliente.moodboardNote.count({ where: { image: fotos } }),
        cliente.moodboardImage.findMany({
          where: fotos,
          select: {
            id: true,
            createdAt: true,
            category: { select: { name: true } },
            uploadedBy: { select: { fullName: true } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
        }),
        cliente.moodboardNote.findMany({
          where: { image: fotos },
          select: {
            id: true,
            imageId: true,
            createdAt: true,
            author: { select: { fullName: true } },
            image: { select: { category: { select: { name: true } } } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
        }),
        cliente.eventMembership.findMany({
          where: { eventId, status: 'ACTIVE' },
          select: {
            role: true,
            user: { select: { id: true, fullName: true, avatarKey: true } },
          },
        }),
        this.comparticionesQueVen({ eventId }),
      ])

    const actividad: (ActividadDeMoodboard & { id: string })[] = [
      ...fotosRecientes.map((f) => ({
        id: f.id,
        kind: 'image' as const,
        imageId: f.id,
        actorName: f.uploadedBy.fullName,
        categoryName: f.category.name,
        at: f.createdAt,
      })),
      ...notasRecientes.map((n) => ({
        id: n.id,
        kind: 'note' as const,
        imageId: n.imageId,
        actorName: n.author.fullName,
        categoryName: n.image.category.name,
        at: n.createdAt,
      })),
    ]
    actividad.sort((a, b) => b.at.getTime() - a.at.getTime() || porTexto(b.id, a.id))

    const colaboradores: Colaborador[] = miembros.map((m) => ({
      userId: m.user.id,
      name: m.user.fullName,
      avatarKey: m.user.avatarKey,
      role: m.role,
      label: m.role === 'COUPLE' ? 'Couple' : 'Planner',
    }))
    // Miembro: proveedores con alguna foto activa compartida vigente. Proveedor:
    // él mismo, siempre (spec §8), aunque aún no le hayan compartido nada.
    const idsProveedor =
      visor.tipo === 'proveedor' ? [visor.userId] : [...new Set(proveedores.map((p) => p.userId))]
    // La etiqueta sale de TODAS sus contrataciones BOOKED del evento, no sólo de
    // las que hoy llevan una foto compartida (ruling del controlador).
    const contratos =
      idsProveedor.length === 0
        ? []
        : await cliente.eventVendor.findMany({
            where: {
              eventId,
              status: 'BOOKED',
              vendorProfile: { userId: { in: idsProveedor } },
            },
            select: {
              category: { select: { name: true } },
              vendorProfile: { select: { userId: true } },
            },
          })
    const categoriasPorProveedor = new Map<string, Set<string>>()
    for (const c of contratos) {
      if (c.vendorProfile === null) continue
      const categorias = categoriasPorProveedor.get(c.vendorProfile.userId) ?? new Set<string>()
      categorias.add(c.category.name)
      categoriasPorProveedor.set(c.vendorProfile.userId, categorias)
    }
    const usuariosProveedor =
      idsProveedor.length === 0
        ? []
        : await cliente.user.findMany({
            where: { id: { in: idsProveedor } },
            select: { id: true, fullName: true, avatarKey: true },
          })
    for (const u of usuariosProveedor) {
      if (colaboradores.some((c) => c.userId === u.id)) continue
      colaboradores.push({
        userId: u.id,
        name: u.fullName,
        avatarKey: u.avatarKey,
        role: 'VENDOR',
        label: [...(categoriasPorProveedor.get(u.id) ?? [])].sort(porTexto).join(' · '),
      })
    }
    const rango = { COUPLE: 0, PLANNER: 1, VENDOR: 2 }
    colaboradores.sort(
      (a, b) =>
        rango[a.role] - rango[b.role] || porTexto(a.name, b.name) || porTexto(a.userId, b.userId),
    )

    return {
      stats: { images, notes },
      activity: actividad.slice(0, 10).map(({ id: _id, ...resto }) => resto),
      collaborators: colaboradores,
    }
  }

  async participantes(imageId: string, excluir: string): Promise<string[]> {
    const cliente = clienteDe(this.prisma)
    const imagen = await cliente.moodboardImage.findUnique({
      where: { id: imageId },
      select: { eventId: true, uploadedById: true },
    })
    if (imagen === null) return []
    const [notas, proveedores, miembros] = await Promise.all([
      cliente.moodboardNote.findMany({ where: { imageId }, select: { authorId: true } }),
      this.proveedoresQueVen(imageId),
      cliente.eventMembership.findMany({
        where: { eventId: imagen.eventId, status: 'ACTIVE' },
        select: { userId: true },
      }),
    ])
    const veHoy = new Set([...proveedores, ...miembros.map((m) => m.userId)])
    const candidatos = new Set([
      imagen.uploadedById,
      ...notas.map((n) => n.authorId),
      ...proveedores,
    ])
    return [...candidatos].filter((u) => u !== excluir && veHoy.has(u)).sort(porTexto)
  }

  /**
   * Comparticiones que HOY dan acceso a su proveedor, sobre las fotos que
   * cumplan `imagen`: foto activa, evento ACTIVE y contratación BOOKED con
   * ficha y del mismo evento que la foto. Única copia de la regla de
   * "proveedor que ve" fuera de `filtroDeVisor`.
   */
  private async comparticionesQueVen(
    imagen: Prisma.MoodboardImageWhereInput,
  ): Promise<{ imageId: string; userId: string; categoryName: string }[]> {
    const filas = await clienteDe(this.prisma).moodboardShare.findMany({
      where: {
        revokedAt: null,
        image: { ...imagen, archivedAt: null, event: { status: 'ACTIVE' } },
        eventVendor: { status: 'BOOKED', vendorProfileId: { not: null } },
      },
      select: {
        imageId: true,
        eventVendor: {
          select: {
            eventId: true,
            category: { select: { name: true } },
            vendorProfile: { select: { userId: true } },
          },
        },
        image: { select: { eventId: true } },
      },
    })
    const lista: { imageId: string; userId: string; categoryName: string }[] = []
    for (const f of filas) {
      if (f.eventVendor.eventId !== f.image.eventId || f.eventVendor.vendorProfile === null)
        continue
      lista.push({
        imageId: f.imageId,
        userId: f.eventVendor.vendorProfile.userId,
        categoryName: f.eventVendor.category.name,
      })
    }
    return lista
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

  private proyectarNota(f: FilaNota): NotaDeMoodboard {
    return {
      id: f.id,
      imageId: f.imageId,
      body: f.body,
      createdAt: f.createdAt,
      author: { id: f.author.id, name: f.author.fullName, avatarKey: f.author.avatarKey },
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
