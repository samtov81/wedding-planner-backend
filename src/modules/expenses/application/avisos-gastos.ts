import type { Logger } from '@nestjs/common'

import {
  type NotificationPort,
  TIPO_GASTO_PAGADO,
} from '@/modules/notifications/application/notification.port'
import type { QueueName, QueuePort } from '@/modules/queue/application/queue.port'

import { type Expense, pasaAPagado } from '../domain/expense'
import type { ExpenseRepository } from './expense.repository'

/**
 * Contrato de los avisos en tiempo real del presupuesto (spec 2026-11-11 §9).
 * Lo PRODUCEN los casos de uso de escritura (crear, editar, borrar) y lo
 * consume el worker de `interfaces/` (Task 8), que emite al socket.
 *
 * Cola PROPIA, `expenses` (ruling C17, como `moodboard`): un worker que toma
 * un job y retorna lo marca completado, así que compartir cola con otro worker
 * le comería los jobs.
 *
 * Un solo nombre de job, `expense.changed`, que lleva ids y LISTAS DE USUARIOS
 * ya decididas, no importes ni conceptos:
 *  - `proveedoresA`: los proveedores cobrados (§5, BOOKED o CANCELLED con
 *    ficha) que ven o dejan de ver el gasto con este cambio. Sólo el caso de uso
 *    lo sabe (el de ANTES ya no se puede leer después), así que va en el job;
 *    el worker les emite `vendor-payment.changed`.
 *  - `campanaA`: a quién se le creó la campana `expense.paid` dentro de la
 *    transacción, para que el worker emita `notification.created`.
 * Quién VE el presupuesto (para `expense.changed`) NO va en el job: el worker
 * lo lee del estado actual (`usuariosConPresupuesto`), así un grant revocado
 * entre el encolado y el consumo no recibe nada. Alternativa descartada: la
 * sala `event:<id>`, que incluye a miembros sin grant (§9).
 *
 * El aviso es latencia sobre un estado que ya está en la base: se encola
 * DESPUÉS del commit y un fallo de Redis se registra y NO se propaga.
 */
export const COLA_GASTOS = 'expenses' satisfies QueueName

/** Nombre del job y, a la vez, del evento de socket para quien ve el presupuesto. */
export const EVENTO_GASTO_CAMBIADO = 'expense.changed'
/** Evento de socket para el proveedor cobrado. Sin datos: el cliente relee `/me/vendor-payments`. */
export const EVENTO_PAGO_PROVEEDOR_CAMBIADO = 'vendor-payment.changed'

export interface JobGastoCambiado {
  eventId: string
  /** userId de los proveedores cobrados que ven o dejan de ver el gasto. */
  proveedoresA: string[]
  /** userId a los que se les creó la campana `expense.paid` en este cambio. */
  campanaA: string[]
}

/**
 * Un gasto cambia muchas veces y cada cambio lleva su propio `proveedoresA`,
 * así que el id NO puede derivarse sólo del gasto: BullMQ descartaría el
 * segundo aviso. Mismo patrón que `jobIdDeImagen` del moodboard: hora en ms,
 * estrictamente creciente dentro del proceso. Se copia en vez de importarse
 * porque la marca es un detalle de `avisos-moodboard.ts`, no un contrato
 * público de ese módulo. Con `-`, nunca `:` (ver `EnqueueOptions.jobId`).
 */
export const jobIdDeGasto = (expenseId: string, epochMs: number): string =>
  `expense-${expenseId}-${epochMs}`

let ultimaMarca = 0

/** `Date.now()`, pero nunca igual ni menor que la marca anterior de este proceso. */
function marcaCreciente(): number {
  ultimaMarca = Math.max(Date.now(), ultimaMarca + 1)
  return ultimaMarca
}

/**
 * Cuando se llama, el cambio ya está confirmado: un fallo de Redis sólo se avisa.
 * Recibe `expenseId` aparte porque el job no lo lleva (el socket no transporta
 * datos del gasto) y el jobId sí lo necesita.
 */
export async function encolarAvisoGasto(
  cola: QueuePort,
  registro: Logger,
  expenseId: string,
  job: JobGastoCambiado,
): Promise<void> {
  try {
    await cola.enqueue(COLA_GASTOS, EVENTO_GASTO_CAMBIADO, job, {
      jobId: jobIdDeGasto(expenseId, marcaCreciente()),
    })
  } catch (error) {
    registro.warn(
      `Gasto guardado pero su aviso no se pudo encolar expenseId=${expenseId}: ` +
        (error instanceof Error ? error.message : String(error)),
    )
  }
}

type GastoParaAviso = Pick<Expense, 'id' | 'concept' | 'status' | 'origen'>

const proveedorDe = (g: GastoParaAviso | null): string | null =>
  g !== null && g.origen.kind === 'vendor' ? g.origen.eventVendorId : null

/**
 * Decide los destinatarios de un cambio y crea la campana. Se llama DENTRO de
 * la unidad de trabajo, con el gasto de antes (`null` al crear) y el de
 * después (`null` al borrar):
 *  - `proveedoresA`: el proveedor cobrado de antes si estaba PAID y el de
 *    después si queda PAID, sin repetir. Cobrado = con ficha y BOOKED o
 *    CANCELLED (§5): un CANCELLED sigue viendo sus pagos, así que también se le
 *    avisa de que cambian.
 *  - campana `expense.paid`: si el gasto pasa a PAID, o cambia de proveedor
 *    estando PAID (para el nuevo es un pago que acaba de aparecer), y el
 *    proveedor de después es BOOKED. Sólo BOOKED porque `visiblesDe` esconde
 *    las campanas de proveedor a quien no está BOOKED: a un CANCELLED la fila
 *    le quedaría invisible. Alternativa descartada: crearla también para el
 *    CANCELLED, que sería avisar a quien no la verá.
 *    Caso conocido (spec 2026-11-11 §9): re-contratar a un proveedor como una
 *    fila nueva de `event_vendors` y mover un gasto PAID de la fila vieja a la
 *    nueva le reenvía `expense.paid`; se acepta porque para esa fila el pago es
 *    nuevo, y no se distingue de un cambio de proveedor cualquiera.
 */
export async function avisosDelCambio(
  gastos: Pick<ExpenseRepository, 'proveedorCobrable'>,
  avisos: Pick<NotificationPort, 'crearParaUsuarios'>,
  eventId: string,
  antes: GastoParaAviso | null,
  despues: GastoParaAviso | null,
): Promise<JobGastoCambiado> {
  const proveedoresA: string[] = []
  const campanaA: string[] = []

  const vendorAntes = antes?.status === 'PAID' ? proveedorDe(antes) : null
  if (vendorAntes !== null) {
    const cobrable = await gastos.proveedorCobrable(vendorAntes)
    if (cobrable !== null && cobrable.status !== 'SHORTLISTED') proveedoresA.push(cobrable.userId)
  }

  const vendorDespues = despues?.status === 'PAID' ? proveedorDe(despues) : null
  if (despues !== null && vendorDespues !== null) {
    const cobrable = await gastos.proveedorCobrable(vendorDespues)
    if (cobrable !== null && cobrable.status !== 'SHORTLISTED') {
      if (!proveedoresA.includes(cobrable.userId)) proveedoresA.push(cobrable.userId)
      const nuevoParaEl =
        pasaAPagado(antes?.status ?? null, despues.status) || proveedorDe(antes) !== vendorDespues
      if (nuevoParaEl && cobrable.status === 'BOOKED') {
        await avisos.crearParaUsuarios(eventId, [cobrable.userId], TIPO_GASTO_PAGADO, {
          expenseId: despues.id,
          concept: despues.concept,
        })
        campanaA.push(cobrable.userId)
      }
    }
  }

  return { eventId, proveedoresA, campanaA }
}
