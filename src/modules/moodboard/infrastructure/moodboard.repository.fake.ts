import { randomUUID } from 'node:crypto'

import type {
  ContratacionCompartible,
  DatosNuevaImagen,
  ImagenDeMoodboard,
  MoodboardRepository,
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
 * El reloj de `crearImagen` avanza 1 ms por foto: dos fotos nunca comparten
 * `createdAt`, así que el orden `createdAt desc` no depende del desempate por
 * id (que en Postgres es un uuid aleatorio).
 */
export class MoodboardRepositoryFake implements MoodboardRepository {
  readonly imagenes: ImagenGuardada[] = []
  readonly comparticiones: ComparticionGuardada[] = []
  readonly eventos = new Map<string, { status: EstadoEvento }>()
  readonly categorias = new Map<
    string,
    { id: string; slug: string; name: string; active: boolean }
  >()
  readonly usuarios = new Map<string, { id: string; name: string; avatarKey: string | null }>()
  readonly contrataciones = new Map<string, ContratacionGuardada>()
  /** Lo consume la Tarea 3 (actividad y colaboradores); aquí sólo se guarda. */
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
    const usuarios = new Set<string>()
    for (const c of this.contrataciones.values()) {
      if (c.userId !== null && this.laVe(imagen, { tipo: 'proveedor', userId: c.userId })) {
        usuarios.add(c.userId)
      }
    }
    return Promise.resolve([...usuarios])
  }

  /** Miembro: todo lo del evento. Proveedor: ver la nota del puerto. */
  private laVe(imagen: ImagenGuardada, visor: Visor): boolean {
    if (visor.tipo === 'miembro') return true
    if (imagen.archivedAt !== null) return false
    if (this.eventos.get(imagen.eventId)?.status !== 'ACTIVE') return false
    return this.comparticiones.some((s) => {
      if (s.imageId !== imagen.id || s.revokedAt !== null) return false
      const c = this.contrataciones.get(s.eventVendorId)
      return (
        c !== undefined &&
        c.status === 'BOOKED' &&
        c.eventId === imagen.eventId &&
        c.userId === visor.userId
      )
    })
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
      noteCount: 0,
      sharedWith,
    }
  }
}
