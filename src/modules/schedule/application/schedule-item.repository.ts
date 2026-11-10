import type { Ubicacion } from '@/shared/domain'

import type { ScheduleItem, ScheduleItemStatus } from '../domain/schedule-item'

export interface DatosNuevoItem {
  eventId: string
  title: string
  description: string | null
  startsAt: Date
  endsAt: Date | null
  location: Ubicacion | null
  status: ScheduleItemStatus
}

export interface CambiosItem {
  title?: string | undefined
  description?: string | null | undefined
  startsAt?: Date | undefined
  endsAt?: Date | null | undefined
  location?: Ubicacion | null | undefined
  status?: ScheduleItemStatus | undefined
}

/** Un proveedor asignado a un ítem, tal como lo ve el cronograma. */
export interface AsignacionVista {
  eventVendorId: string
  name: string
  categoryName: string
  confirmed: boolean
}

export interface ItemConAsignaciones extends ScheduleItem {
  /** Sólo las asignaciones vigentes, por nombre (desempate por `eventVendorId`). */
  vendors: AsignacionVista[]
}

/** Contratación a la que se puede asignar un ítem: `BOOKED` y con ficha. */
export interface Asignable {
  eventVendorId: string
  name: string
  categoryName: string
  userId: string
}

/** Un proveedor (usuario) en "Vendors Ready": listo si todo lo suyo vigente está confirmado. */
export interface EstadoProveedor {
  userId: string
  name: string
  avatarKey: string | null
  ready: boolean
}

/**
 * Un ítem que el proveedor tiene sin confirmar, con la hora que vio. `confirmar`
 * recibe esta misma forma de vuelta y sólo confirma si la hora sigue igual.
 */
export interface PendienteDeProveedor {
  itemId: string
  startsAt: Date
  endsAt: Date | null
}

/** Una nota del planner sobre un ítem (spec 2026-11-10 §7). Sin editar ni borrar. */
export interface NotaDeItem {
  id: string
  itemId: string
  body: string
  createdAt: Date
  author: { id: string; name: string; avatarKey: string | null }
}

/**
 * A quién y de qué avisar en un recordatorio, tal como está AHORA (spec
 * 2026-11-10 §5): el worker lo pide justo antes de avisar para descartar los
 * jobs obsoletos.
 */
export interface DestinoRecordatorio {
  userId: string
  eventId: string
  title: string
  status: ScheduleItemStatus
  startsAt: Date
}

/**
 * Asignaciones (ítem × contratación) y confirmaciones (spec 2026-11-10 §3–§4).
 *
 * "Vigente" = asignación cuya contratación está `BOOKED` y tiene ficha. Una
 * asignación que no es vigente sigue existiendo (vuelve a contar si se
 * recontrata) pero no cuenta en `vendors`, `usuariosAsignados`,
 * `estadoConfirmaciones`, `pendientesDe` ni `usuariosConPendientes`.
 * Alternativa descartada: borrar las filas al cancelar, que perdería las
 * asignaciones de un proveedor que vuelve.
 */
export interface ScheduleItemRepository {
  listarPorEvento(eventId: string): Promise<ScheduleItem[]> // startsAt asc, id asc
  buscarPorId(eventId: string, itemId: string): Promise<ScheduleItem | null>
  crear(datos: DatosNuevoItem): Promise<ScheduleItem>
  actualizar(eventId: string, itemId: string, cambios: CambiosItem): Promise<ScheduleItem> // 404 si no existe
  eliminar(eventId: string, itemId: string): Promise<boolean> // false si no existía

  /**
   * `SELECT … FOR UPDATE` de las filas de esos ítems del evento, en orden de
   * id (dos transacciones que bloquean conjuntos solapados los toman en el
   * mismo orden y no se interbloquean). Sólo tiene efecto dentro de una
   * `UnidadDeTrabajo`; los ids que no existen o son de otro evento se ignoran.
   *
   * Lo llaman, lo PRIMERO de su transacción, editar (cambio de hora), asignar
   * y confirmar. Sin él:
   *  - un proveedor que confirma mientras el planner cambia la hora podría
   *    confirmar la hora vieja: el UPDATE de `confirmar` compara con la hora
   *    de su instantánea, que no ve el cambio aún sin confirmar (spec
   *    2026-11-10 §4, "la confirmación no pisa una desconfirmación");
   *  - dos `fijarAsignaciones` concurrentes sobre el mismo ítem leerían las
   *    dos "sin fila" y la segunda chocaría con el UNIQUE (P2002 → 500).
   * Con el bloqueo, la segunda transacción espera y su primera lectura ya ve
   * lo confirmado por la primera.
   *
   * Por qué las filas de los ÍTEMS y no la del evento (como `bloquearYContar`
   * del moodboard): serializa exactamente lo que comparte el invariante, sin
   * frenar al resto del evento (invitados, gastos, otras partes del
   * cronograma). Alternativa descartada: `SERIALIZABLE` en la transacción,
   * que obliga a reintentar en el caso de uso por fallos de serialización.
   */
  bloquearItems(eventId: string, itemIds: string[]): Promise<void>

  listarConAsignaciones(eventId: string): Promise<ItemConAsignaciones[]> // startsAt asc, id asc
  buscarConAsignaciones(eventId: string, itemId: string): Promise<ItemConAsignaciones | null>
  listarAsignables(eventId: string): Promise<Asignable[]> // BOOKED con ficha, por nombre
  /**
   * Deja el ítem asignado exactamente a `eventVendorIds` entre sus asignaciones
   * VIGENTES. Altas: pedidos sin fila (nacen sin confirmar). Bajas: vigentes no
   * pedidas (se borran). Una fila no vigente (contratación cancelada) no es ni
   * alta ni baja: se conserva para cuando se recontrate. El caso de uso ya ha
   * rechazado con 422 lo que no es asignable. Ambas listas, ordenadas.
   */
  fijarAsignaciones(
    itemId: string,
    eventVendorIds: string[],
    por: string,
  ): Promise<{ altas: string[]; bajas: string[] }>
  /** Todas las asignaciones del ítem vuelven a "sin confirmar" (cambio de hora). */
  desconfirmarItem(itemId: string): Promise<void>
  /** userIds con alguna asignación vigente en el ítem, sin repetir y ordenados. */
  usuariosAsignados(itemId: string): Promise<string[]>
  /** Un elemento por usuario con alguna asignación vigente en el evento, por nombre. */
  estadoConfirmaciones(eventId: string): Promise<EstadoProveedor[]>
  /** Ítems con alguna asignación vigente del usuario sin confirmar; startsAt asc, id asc. */
  pendientesDe(eventId: string, userId: string): Promise<PendienteDeProveedor[]>
  /**
   * Confirma las asignaciones vigentes y sin confirmar del usuario cuyo ítem
   * está en `vistos` con la MISMA `startsAt` y `endsAt` que ahora: si la hora
   * cambió entre que el proveedor miró y pulsó, esa asignación queda pendiente
   * (spec 2026-11-10 §4, "se confirma lo que el proveedor tenía delante").
   */
  confirmar(eventId: string, userId: string, vistos: PendienteDeProveedor[]): Promise<void>
  /** userIds con alguna asignación vigente sin confirmar en el evento, ordenados. */
  usuariosConPendientes(eventId: string): Promise<string[]>

  /** Notas del ítem, de la más antigua a la más reciente (desempate por id). */
  listarNotas(itemId: string): Promise<NotaDeItem[]>
  /** El caso de uso ya recortó (`trim`) y validó 1..2000; la base lo vuelve a exigir con un CHECK. */
  crearNota(itemId: string, authorId: string, body: string): Promise<NotaDeItem>
  /** itemId → número de notas de los ítems del evento; los ítems sin notas no aparecen. */
  contarNotas(eventId: string): Promise<Map<string, number>>
  /**
   * null si el ítem no existe, la asignación no está, la contratación ya no es
   * vigente (`BOOKED` con ficha) o el evento no está `ACTIVE`. Comprueba el
   * estado de la base, no el del job que lo pide (spec 2026-11-10 §5).
   */
  destinoRecordatorio(itemId: string, eventVendorId: string): Promise<DestinoRecordatorio | null>
  /**
   * Asignaciones vigentes de esa contratación con `startsAt > ahora`, por hora
   * y luego por ítem: lo que hay que reprogramar al recontratarla.
   */
  asignacionesFuturas(
    eventVendorId: string,
    ahora: Date,
  ): Promise<{ itemId: string; startsAt: Date }[]>
}

export const SCHEDULE_ITEM_REPOSITORY = Symbol('SCHEDULE_ITEM_REPOSITORY')
