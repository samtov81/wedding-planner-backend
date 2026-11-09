import { randomUUID } from 'node:crypto'

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

type EstadoEvento = 'DRAFT' | 'ACTIVE'
type EstadoContratacion = 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'

interface ImagenGuardada {
  id: string
  eventId: string
  categoryId: string
  title: string
  storageKey: string
  width: number
  height: number
  uploadedById: string
  createdAt: Date
  archivedAt: Date | null
  archivedById: string | null
}

interface ComparticionGuardada {
  imageId: string
  eventVendorId: string
  sharedById: string
  revokedAt: Date | null
}

interface NotaGuardada {
  id: string
  imageId: string
  authorId: string
  body: string
  createdAt: Date
}

interface ContratacionGuardada {
  id: string
  eventId: string
  userId: string | null
  name: string
  categoryName: string
  status: EstadoContratacion
}

const porTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Doble en memoria del puerto. Los `sembrar*` dejan en pie lo que en Postgres
 * son filas de otros módulos (eventos, categorías, usuarios, contrataciones,
 * membresías); volver a sembrar el mismo id lo SOBRESCRIBE, que es como los
 * tests de paridad cambian el estado de un evento o de una contratación.
 *
 * El reloj de `crearImagen` y `crearNota` avanza 1 ms por escritura: dos
 * escrituras nunca comparten `createdAt`, así que el orden `createdAt desc` no depende del desempate por
 * id (que en Postgres es un uuid aleatorio).
 */
export class MoodboardRepositoryFake implements MoodboardRepository {
  readonly imagenes: ImagenGuardada[] = []
  readonly comparticiones: ComparticionGuardada[] = []
  readonly notas: NotaGuardada[] = []
  readonly eventos = new Map<string, { status: EstadoEvento }>()
  readonly categorias = new Map<
    string,
    { id: string; slug: string; name: string; active: boolean }
  >()
  readonly usuarios = new Map<string, { id: string; name: string; avatarKey: string | null }>()
  readonly contrataciones = new Map<string, ContratacionGuardada>()
  readonly miembros: { eventId: string; userId: string; role: string; status: string }[] = []
  private reloj = Date.UTC(2027, 0, 1)

  sembrarEvento(eventId: string, datos: { status: EstadoEvento }): void {
    this.eventos.set(eventId, { ...datos })
  }

  sembrarCategoria(datos: { id: string; slug: string; name: string; active: boolean }): void {
    this.categorias.set(datos.id, { ...datos })
  }

  sembrarUsuario(datos: { id: string; name: string; avatarKey?: string }): void {
    this.usuarios.set(datos.id, {
      id: datos.id,
      name: datos.name,
      avatarKey: datos.avatarKey ?? null,
    })
  }

  sembrarContratacion(datos: {
    id: string
    eventId: string
    userId: string | null
    name: string
    categoryName: string
    status: EstadoContratacion
  }): void {
    this.contrataciones.set(datos.id, { ...datos })
  }

  sembrarMiembro(datos: { eventId: string; userId: string; role: string; status: string }): void {
    this.miembros.push({ ...datos })
  }

  bloquearYContar(eventId: string): Promise<number> {
    return Promise.resolve(this.imagenes.filter((i) => i.eventId === eventId).length)
  }

  /**
   * No hace nada: el doble corre en un solo hilo y sin transacciones reales, así
   * que no hay intercalado que serializar. La serialización se prueba contra
   * Postgres (`prisma-moodboard.repository.test.ts`).
   */
  bloquearImagen(): Promise<void> {
    return Promise.resolve()
  }

  categoriaActiva(categoryId: string): Promise<boolean> {
    return Promise.resolve(this.categorias.get(categoryId)?.active === true)
  }

  crearImagen(datos: DatosNuevaImagen): Promise<ImagenDeMoodboard> {
    if (this.imagenes.some((i) => i.storageKey === datos.storageKey)) {
      return Promise.reject(new Error('storageKey duplicada'))
    }
    this.reloj += 1
    const guardada: ImagenGuardada = {
      ...datos,
      id: randomUUID(),
      createdAt: new Date(this.reloj),
      archivedAt: null,
      archivedById: null,
    }
    this.imagenes.push(guardada)
    return Promise.resolve(this.proyectar(guardada))
  }

  listarImagenes(eventId: string, visor: Visor, archivadas: boolean): Promise<ImagenDeMoodboard[]> {
    if (visor.tipo === 'proveedor' && archivadas) return Promise.resolve([])
    return Promise.resolve(
      this.imagenes
        .filter(
          (i) =>
            i.eventId === eventId && (i.archivedAt !== null) === archivadas && this.laVe(i, visor),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || porTexto(b.id, a.id))
        .map((i) => this.proyectar(i)),
    )
  }

  buscarImagen(eventId: string, imageId: string, visor: Visor): Promise<ImagenDeMoodboard | null> {
    const imagen = this.imagenes.find((i) => i.id === imageId && i.eventId === eventId)
    if (imagen === undefined || !this.laVe(imagen, visor)) return Promise.resolve(null)
    return Promise.resolve(this.proyectar(imagen))
  }

  fijarArchivo(imageId: string, por: string | null): Promise<void> {
    const imagen = this.imagenes.find((i) => i.id === imageId)
    if (imagen !== undefined) {
      imagen.archivedAt = por === null ? null : new Date()
      imagen.archivedById = por
    }
    return Promise.resolve()
  }

  listarCompartibles(eventId: string): Promise<ContratacionCompartible[]> {
    const lista: ContratacionCompartible[] = []
    for (const c of this.contrataciones.values()) {
      if (c.eventId === eventId && c.status === 'BOOKED' && c.userId !== null) {
        lista.push({
          eventVendorId: c.id,
          name: c.name,
          categoryName: c.categoryName,
          userId: c.userId,
        })
      }
    }
    return Promise.resolve(
      lista.sort((a, b) => porTexto(a.name, b.name) || porTexto(a.eventVendorId, b.eventVendorId)),
    )
  }

  fijarComparticion(
    imageId: string,
    eventVendorIds: string[],
    por: string,
  ): Promise<{ altas: string[]; bajas: string[] }> {
    const vigentes = this.comparticiones.filter(
      (s) => s.imageId === imageId && s.revokedAt === null,
    )
    const vigentesIds = new Set(vigentes.map((s) => s.eventVendorId))
    const pedidos = new Set(eventVendorIds)
    const altas = [...pedidos].filter((id) => !vigentesIds.has(id)).sort(porTexto)
    const bajas = [...vigentesIds].filter((id) => !pedidos.has(id)).sort(porTexto)
    for (const id of altas) {
      const previa = this.comparticiones.find(
        (s) => s.imageId === imageId && s.eventVendorId === id,
      )
      if (previa === undefined) {
        this.comparticiones.push({ imageId, eventVendorId: id, sharedById: por, revokedAt: null })
      } else {
        previa.revokedAt = null
        previa.sharedById = por
      }
    }
    for (const s of vigentes) {
      if (bajas.includes(s.eventVendorId)) s.revokedAt = new Date()
    }
    return Promise.resolve({ altas, bajas })
  }

  usuariosDeContrataciones(eventVendorIds: string[]): Promise<string[]> {
    const usuarios = new Set<string>()
    for (const id of eventVendorIds) {
      const userId = this.contrataciones.get(id)?.userId
      if (userId !== undefined && userId !== null) usuarios.add(userId)
    }
    return Promise.resolve([...usuarios])
  }

  proveedoresQueVen(imageId: string): Promise<string[]> {
    const imagen = this.imagenes.find((i) => i.id === imageId)
    if (imagen === undefined) return Promise.resolve([])
    return Promise.resolve([...new Set(this.contratacionesQueVen(imagen).map((c) => c.userId))])
  }

  listarNotas(imageId: string): Promise<NotaDeMoodboard[]> {
    return Promise.resolve(
      this.notas
        .filter((n) => n.imageId === imageId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || porTexto(a.id, b.id))
        .map((n) => this.proyectarNota(n)),
    )
  }

  crearNota(imageId: string, authorId: string, body: string): Promise<NotaDeMoodboard> {
    this.reloj += 1
    const guardada: NotaGuardada = {
      id: randomUUID(),
      imageId,
      authorId,
      body,
      createdAt: new Date(this.reloj),
    }
    this.notas.push(guardada)
    return Promise.resolve(this.proyectarNota(guardada))
  }

  resumen(eventId: string, visor: Visor): Promise<ResumenCrudo> {
    const visibles = this.imagenes.filter(
      (i) => i.eventId === eventId && i.archivedAt === null && this.laVe(i, visor),
    )
    const ids = new Set(visibles.map((i) => i.id))
    const notas = this.notas.filter((n) => ids.has(n.imageId))
    const nombreDe = (userId: string) => this.usuarios.get(userId)?.name ?? ''
    const categoriaDe = (imagen: ImagenGuardada) =>
      this.categorias.get(imagen.categoryId)?.name ?? ''

    const actividad: (ActividadDeMoodboard & { id: string })[] = [
      ...visibles.map((i) => ({
        id: i.id,
        kind: 'image' as const,
        imageId: i.id,
        actorName: nombreDe(i.uploadedById),
        categoryName: categoriaDe(i),
        at: i.createdAt,
      })),
      ...notas.map((n) => ({
        id: n.id,
        kind: 'note' as const,
        imageId: n.imageId,
        actorName: nombreDe(n.authorId),
        categoryName: categoriaDe(visibles.find((i) => i.id === n.imageId) as ImagenGuardada),
        at: n.createdAt,
      })),
    ]
    actividad.sort((a, b) => b.at.getTime() - a.at.getTime() || porTexto(b.id, a.id))

    const colaboradores: Colaborador[] = []
    for (const m of this.miembros) {
      if (m.eventId !== eventId || m.status !== 'ACTIVE') continue
      if (m.role !== 'COUPLE' && m.role !== 'PLANNER') continue
      const u = this.usuarios.get(m.userId)
      colaboradores.push({
        userId: m.userId,
        name: u?.name ?? '',
        avatarKey: u?.avatarKey ?? null,
        role: m.role,
        label: m.role === 'COUPLE' ? 'Couple' : 'Planner',
      })
    }
    // Miembro: proveedores con alguna foto activa compartida vigente. Proveedor:
    // él mismo, siempre. Etiqueta: todas sus contrataciones BOOKED del evento.
    const idsProveedor = new Set<string>(visor.tipo === 'proveedor' ? [visor.userId] : [])
    if (visor.tipo === 'miembro') {
      for (const imagen of visibles) {
        for (const c of this.contratacionesQueVen(imagen)) idsProveedor.add(c.userId)
      }
    }
    for (const userId of idsProveedor) {
      if (colaboradores.some((c) => c.userId === userId)) continue
      const categorias = new Set<string>()
      for (const c of this.contrataciones.values()) {
        if (c.eventId === eventId && c.status === 'BOOKED' && c.userId === userId) {
          categorias.add(c.categoryName)
        }
      }
      const u = this.usuarios.get(userId)
      colaboradores.push({
        userId,
        name: u?.name ?? '',
        avatarKey: u?.avatarKey ?? null,
        role: 'VENDOR',
        label: [...categorias].sort(porTexto).join(' · '),
      })
    }
    const rango = { COUPLE: 0, PLANNER: 1, VENDOR: 2 }
    colaboradores.sort(
      (a, b) =>
        rango[a.role] - rango[b.role] || porTexto(a.name, b.name) || porTexto(a.userId, b.userId),
    )

    return Promise.resolve({
      stats: { images: visibles.length, notes: notas.length },
      activity: actividad.slice(0, 10).map(({ id: _id, ...resto }) => resto),
      collaborators: colaboradores,
    })
  }

  participantes(imageId: string, excluir: string): Promise<string[]> {
    const imagen = this.imagenes.find((i) => i.id === imageId)
    if (imagen === undefined) return Promise.resolve([])
    const proveedores = new Set(this.contratacionesQueVen(imagen).map((c) => c.userId))
    const miembros = new Set(
      this.miembros
        .filter((m) => m.eventId === imagen.eventId && m.status === 'ACTIVE')
        .map((m) => m.userId),
    )
    const candidatos = new Set([
      imagen.uploadedById,
      ...this.notas.filter((n) => n.imageId === imageId).map((n) => n.authorId),
      ...proveedores,
    ])
    return Promise.resolve(
      [...candidatos]
        .filter((u) => u !== excluir && (miembros.has(u) || proveedores.has(u)))
        .sort(porTexto),
    )
  }

  /**
   * Contrataciones que HOY dan acceso a la foto a su proveedor: foto activa,
   * evento ACTIVE y compartición vigente con una contratación BOOKED del mismo
   * evento y con ficha. Única copia de la regla en el doble.
   */
  private contratacionesQueVen(
    imagen: ImagenGuardada,
  ): (ContratacionGuardada & { userId: string })[] {
    if (imagen.archivedAt !== null) return []
    if (this.eventos.get(imagen.eventId)?.status !== 'ACTIVE') return []
    const lista: (ContratacionGuardada & { userId: string })[] = []
    for (const s of this.comparticiones) {
      if (s.imageId !== imagen.id || s.revokedAt !== null) continue
      const c = this.contrataciones.get(s.eventVendorId)
      if (
        c !== undefined &&
        c.status === 'BOOKED' &&
        c.eventId === imagen.eventId &&
        c.userId !== null
      ) {
        lista.push({ ...c, userId: c.userId })
      }
    }
    return lista
  }

  /** Miembro: todo lo del evento. Proveedor: ver la nota del puerto. */
  private laVe(imagen: ImagenGuardada, visor: Visor): boolean {
    if (visor.tipo === 'miembro') return true
    return this.contratacionesQueVen(imagen).some((c) => c.userId === visor.userId)
  }

  private proyectarNota(n: NotaGuardada): NotaDeMoodboard {
    const autor = this.usuarios.get(n.authorId)
    return {
      id: n.id,
      imageId: n.imageId,
      body: n.body,
      createdAt: n.createdAt,
      author: { id: n.authorId, name: autor?.name ?? '', avatarKey: autor?.avatarKey ?? null },
    }
  }

  private proyectar(i: ImagenGuardada): ImagenDeMoodboard {
    const categoria = this.categorias.get(i.categoryId)
    const sharedWith = this.comparticiones
      .filter((s) => s.imageId === i.id && s.revokedAt === null)
      .map((s) => ({
        eventVendorId: s.eventVendorId,
        name: this.contrataciones.get(s.eventVendorId)?.name ?? '',
      }))
      .sort((a, b) => porTexto(a.name, b.name) || porTexto(a.eventVendorId, b.eventVendorId))
    return {
      id: i.id,
      eventId: i.eventId,
      title: i.title,
      storageKey: i.storageKey,
      width: i.width,
      height: i.height,
      category: {
        id: i.categoryId,
        slug: categoria?.slug ?? '',
        name: categoria?.name ?? '',
      },
      uploadedBy: { id: i.uploadedById, name: this.usuarios.get(i.uploadedById)?.name ?? '' },
      createdAt: i.createdAt,
      archivedAt: i.archivedAt,
      noteCount: this.notas.filter((n) => n.imageId === i.id).length,
      sharedWith,
    }
  }
}
