import { randomUUID } from 'node:crypto'

import type {
  Asignable,
  AsignacionVista,
  CambiosItem,
  DatosNuevoItem,
  DestinoRecordatorio,
  EstadoProveedor,
  ItemConAsignaciones,
  NotaDeItem,
  PendienteDeProveedor,
  ScheduleItemRepository,
} from '../application/schedule-item.repository'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import type { ScheduleItem } from '../domain/schedule-item'

type EstadoEvento = 'DRAFT' | 'ACTIVE'
type EstadoContratacion = 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'

interface ContratacionGuardada {
  id: string
  eventId: string
  /** null = contratación externa (sin ficha). */
  userId: string | null
  name: string
  categoryName: string
  status: EstadoContratacion
}

interface AsignacionGuardada {
  scheduleItemId: string
  eventVendorId: string
  assignedById: string
  createdAt: Date
  confirmedAt: Date | null
}

/** Una asignación vigente: la fila guardada (para escribir en ella) y su contratación. */
interface Vigente {
  fila: AsignacionGuardada
  contratacion: ContratacionGuardada & { userId: string }
}

const porTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const porHora = (a: ScheduleItem, b: ScheduleItem): number =>
  a.startsAt.getTime() - b.startsAt.getTime() || porTexto(a.id, b.id)

const mismoInstante = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime()

/**
 * Doble en memoria del puerto. Los `sembrar*` dejan en pie lo que en Postgres
 * son filas de otros módulos (eventos, usuarios, contrataciones); volver a
 * sembrar el mismo id lo SOBRESCRIBE, que es como los tests cambian el estado
 * de una contratación (cancelar y recontratar). Mismo patrón que
 * `MoodboardRepositoryFake`.
 */
export class ScheduleItemRepositoryEnMemoria implements ScheduleItemRepository {
  readonly items: ScheduleItem[] = []
  readonly asignaciones: AsignacionGuardada[] = []
  readonly notas: NotaDeItem[] = []
  readonly eventos = new Map<string, { status: EstadoEvento }>()
  readonly usuarios = new Map<string, { id: string; name: string; avatarKey: string | null }>()
  readonly contrataciones = new Map<string, ContratacionGuardada>()

  sembrarEvento(eventId: string, datos: { status: EstadoEvento }): void {
    this.eventos.set(eventId, { ...datos })
  }

  sembrarUsuario(datos: { id: string; name: string; avatarKey?: string }): void {
    this.usuarios.set(datos.id, {
      id: datos.id,
      name: datos.name,
      avatarKey: datos.avatarKey ?? null,
    })
  }

  sembrarContratacion(datos: ContratacionGuardada): void {
    this.contrataciones.set(datos.id, { ...datos })
  }

  listarPorEvento(eventId: string): Promise<ScheduleItem[]> {
    return Promise.resolve(
      this.items
        .filter((i) => i.eventId === eventId)
        .sort(porHora)
        .map((i) => ({ ...i })),
    )
  }

  buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null> {
    const item = this.items.find((i) => i.id === itemId && i.eventId === eventId)
    return Promise.resolve(item === undefined ? null : { ...item })
  }

  crear(datos: DatosNuevoItem): Promise<ScheduleItem> {
    const ahora = new Date()
    const item: ScheduleItem = { ...datos, id: randomUUID(), createdAt: ahora, updatedAt: ahora }
    this.items.push(item)
    return Promise.resolve({ ...item })
  }

  actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> {
    const item = this.items.find((i) => i.id === itemId && i.eventId === eventId)
    if (item === undefined) return Promise.reject(new ItemDeCronogramaNoEncontradoError())
    Object.assign(
      item,
      Object.fromEntries(Object.entries(cambios).filter(([, valor]) => valor !== undefined)),
    )
    item.updatedAt = new Date()
    return Promise.resolve({ ...item })
  }

  /** Borra también sus asignaciones y notas: en Postgres son las cascadas de la FK. */
  eliminar(eventId: string, itemId: string): Promise<boolean> {
    const indice = this.items.findIndex((i) => i.id === itemId && i.eventId === eventId)
    if (indice === -1) return Promise.resolve(false)
    this.items.splice(indice, 1)
    this.quitarAsignaciones((a) => a.scheduleItemId === itemId)
    const quedan = this.notas.filter((n) => n.itemId !== itemId)
    this.notas.splice(0, this.notas.length, ...quedan)
    return Promise.resolve(true)
  }

  /**
   * No hace nada: el doble corre en un solo hilo y sin transacciones reales, así
   * que no hay intercalado que serializar. La serialización se prueba contra
   * Postgres (`prisma-schedule-item.repository.test.ts`).
   */
  bloquearItems(): Promise<void> {
    return Promise.resolve()
  }

  listarConAsignaciones(eventId: string): Promise<ItemConAsignaciones[]> {
    return Promise.resolve(
      this.items
        .filter((i) => i.eventId === eventId)
        .sort(porHora)
        .map((i) => this.conAsignaciones(i)),
    )
  }

  buscarConAsignaciones(eventId: string, itemId: string): Promise<ItemConAsignaciones | null> {
    const item = this.items.find((i) => i.id === itemId && i.eventId === eventId)
    return Promise.resolve(item === undefined ? null : this.conAsignaciones(item))
  }

  listarAsignables(eventId: string): Promise<Asignable[]> {
    const lista: Asignable[] = []
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

  fijarAsignaciones(
    itemId: string,
    eventVendorIds: string[],
    por: string,
  ): Promise<{ altas: string[]; bajas: string[] }> {
    const existentes = new Set(
      this.asignaciones.filter((a) => a.scheduleItemId === itemId).map((a) => a.eventVendorId),
    )
    const vigentes = new Set(
      this.vigentes((a) => a.scheduleItemId === itemId).map((v) => v.fila.eventVendorId),
    )
    const pedidos = new Set(eventVendorIds)
    const altas = [...pedidos].filter((id) => !existentes.has(id)).sort(porTexto)
    const bajas = [...vigentes].filter((id) => !pedidos.has(id)).sort(porTexto)
    for (const eventVendorId of altas) {
      this.asignaciones.push({
        scheduleItemId: itemId,
        eventVendorId,
        assignedById: por,
        createdAt: new Date(),
        confirmedAt: null,
      })
    }
    this.quitarAsignaciones((a) => a.scheduleItemId === itemId && bajas.includes(a.eventVendorId))
    return Promise.resolve({ altas, bajas })
  }

  desconfirmarItem(itemId: string): Promise<void> {
    for (const a of this.asignaciones) {
      if (a.scheduleItemId === itemId) a.confirmedAt = null
    }
    return Promise.resolve()
  }

  usuariosAsignados(itemId: string): Promise<string[]> {
    const usuarios = this.vigentes((a) => a.scheduleItemId === itemId).map(
      (v) => v.contratacion.userId,
    )
    return Promise.resolve([...new Set(usuarios)].sort(porTexto))
  }

  /**
   * El nombre es el de la contratación (en Postgres, `businessName` de la
   * ficha). Un usuario tiene UNA ficha, así que todas sus contrataciones
   * comparten nombre en Postgres; el doble permite sembrar nombres distintos y,
   * si pasa, se queda con el primero por orden alfabético, igual que el
   * adaptador Prisma.
   */
  estadoConfirmaciones(eventId: string): Promise<EstadoProveedor[]> {
    const porUsuario = new Map<string, { name: string; ready: boolean }>()
    for (const { fila, contratacion } of this.vigentes(
      (a) => this.itemDe(a)?.eventId === eventId,
    )) {
      const previo = porUsuario.get(contratacion.userId)
      const nombre = contratacion.name
      porUsuario.set(contratacion.userId, {
        name: previo === undefined || porTexto(nombre, previo.name) < 0 ? nombre : previo.name,
        ready: (previo?.ready ?? true) && fila.confirmedAt !== null,
      })
    }
    const lista: EstadoProveedor[] = [...porUsuario].map(([userId, { name, ready }]) => ({
      userId,
      name,
      avatarKey: this.usuarios.get(userId)?.avatarKey ?? null,
      ready,
    }))
    return Promise.resolve(
      lista.sort((a, b) => porTexto(a.name, b.name) || porTexto(a.userId, b.userId)),
    )
  }

  pendientesDe(eventId: string, userId: string): Promise<PendienteDeProveedor[]> {
    const ids = new Set(
      this.vigentes(
        (a) =>
          a.confirmedAt === null &&
          this.itemDe(a)?.eventId === eventId &&
          this.contrataciones.get(a.eventVendorId)?.userId === userId,
      ).map((v) => v.fila.scheduleItemId),
    )
    return Promise.resolve(
      this.items
        .filter((i) => ids.has(i.id))
        .sort(porHora)
        .map((i) => ({ itemId: i.id, startsAt: i.startsAt, endsAt: i.endsAt })),
    )
  }

  confirmar(eventId: string, userId: string, vistos: PendienteDeProveedor[]): Promise<void> {
    const ahora = new Date()
    for (const { fila, contratacion } of this.vigentes((a) => a.confirmedAt === null)) {
      if (contratacion.userId !== userId) continue
      const item = this.itemDe(fila)
      if (item === undefined || item.eventId !== eventId) continue
      const visto = vistos.find((v) => v.itemId === item.id)
      if (
        visto !== undefined &&
        mismoInstante(visto.startsAt, item.startsAt) &&
        mismoInstante(visto.endsAt, item.endsAt)
      ) {
        fila.confirmedAt = ahora
      }
    }
    return Promise.resolve()
  }

  usuariosConPendientes(eventId: string): Promise<string[]> {
    const usuarios = this.vigentes(
      (a) => a.confirmedAt === null && this.itemDe(a)?.eventId === eventId,
    ).map((v) => v.contratacion.userId)
    return Promise.resolve([...new Set(usuarios)].sort(porTexto))
  }

  /** Orden de inserción: es el cronológico (en Postgres, `createdAt` y luego id). */
  listarNotas(itemId: string): Promise<NotaDeItem[]> {
    return Promise.resolve(
      this.notas.filter((n) => n.itemId === itemId).map((n) => ({ ...n, author: { ...n.author } })),
    )
  }

  /** Autor desconocido: en Postgres sería la FK; el doble lo rechaza igual. */
  crearNota(itemId: string, authorId: string, body: string): Promise<NotaDeItem> {
    const autor = this.usuarios.get(authorId)
    if (autor === undefined) return Promise.reject(new Error('autor desconocido'))
    const nota: NotaDeItem = {
      id: randomUUID(),
      itemId,
      body,
      createdAt: new Date(),
      author: { id: autor.id, name: autor.name, avatarKey: autor.avatarKey },
    }
    this.notas.push(nota)
    return Promise.resolve({ ...nota, author: { ...nota.author } })
  }

  contarNotas(eventId: string): Promise<Map<string, number>> {
    const cuentas = new Map<string, number>()
    for (const n of this.notas) {
      if (this.items.find((i) => i.id === n.itemId)?.eventId !== eventId) continue
      cuentas.set(n.itemId, (cuentas.get(n.itemId) ?? 0) + 1)
    }
    return Promise.resolve(cuentas)
  }

  destinoRecordatorio(itemId: string, eventVendorId: string): Promise<DestinoRecordatorio | null> {
    const [vigente] = this.vigentes(
      (a) => a.scheduleItemId === itemId && a.eventVendorId === eventVendorId,
    )
    const item = this.items.find((i) => i.id === itemId)
    if (vigente === undefined || item === undefined) return Promise.resolve(null)
    if (this.eventos.get(item.eventId)?.status !== 'ACTIVE') return Promise.resolve(null)
    return Promise.resolve({
      userId: vigente.contratacion.userId,
      eventId: item.eventId,
      title: item.title,
      status: item.status,
      startsAt: item.startsAt,
    })
  }

  asignacionesFuturas(
    eventVendorId: string,
    ahora: Date,
  ): Promise<{ itemId: string; startsAt: Date }[]> {
    const futuras = this.vigentes((a) => a.eventVendorId === eventVendorId)
      .map((v) => this.itemDe(v.fila))
      .filter((i): i is ScheduleItem => i !== undefined && i.startsAt.getTime() > ahora.getTime())
      .sort(porHora)
    return Promise.resolve(futuras.map((i) => ({ itemId: i.id, startsAt: i.startsAt })))
  }

  /**
   * Asignaciones que cumplen `filtro` y son VIGENTES: contratación `BOOKED` y
   * con ficha. Única copia de la regla en el doble. `fila` es la guardada (no
   * una copia), para que `confirmar` pueda escribir en ella.
   */
  private vigentes(filtro: (a: AsignacionGuardada) => boolean): Vigente[] {
    const lista: Vigente[] = []
    for (const a of this.asignaciones) {
      if (!filtro(a)) continue
      const c = this.contrataciones.get(a.eventVendorId)
      if (c === undefined || c.status !== 'BOOKED' || c.userId === null) continue
      lista.push({ fila: a, contratacion: { ...c, userId: c.userId } })
    }
    return lista
  }

  private itemDe(a: AsignacionGuardada): ScheduleItem | undefined {
    return this.items.find((i) => i.id === a.scheduleItemId)
  }

  private quitarAsignaciones(cumple: (a: AsignacionGuardada) => boolean): void {
    const quedan = this.asignaciones.filter((a) => !cumple(a))
    this.asignaciones.splice(0, this.asignaciones.length, ...quedan)
  }

  private conAsignaciones(item: ScheduleItem): ItemConAsignaciones {
    const vendors: AsignacionVista[] = this.vigentes((a) => a.scheduleItemId === item.id)
      .map(({ fila, contratacion }) => ({
        eventVendorId: fila.eventVendorId,
        name: contratacion.name,
        categoryName: contratacion.categoryName,
        confirmed: fila.confirmedAt !== null,
      }))
      .sort((a, b) => porTexto(a.name, b.name) || porTexto(a.eventVendorId, b.eventVendorId))
    return { ...item, vendors }
  }
}
