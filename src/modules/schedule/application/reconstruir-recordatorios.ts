import { Logger } from '@nestjs/common'

import type { QueueName, QueuePort } from '@/modules/queue/application/queue.port'

import { encolarRecordatorios } from './avisos-cronograma'
import type { ScheduleItemRepository } from './schedule-item.repository'

/**
 * Cola del barrido. `maintenance` ya existía en `QueueName` sin productor ni
 * worker; el barrido es su primer uso (decisión del review final de la
 * rama). Si otro módulo monta un worker en esta cola, se comerán los jobs
 * entre ellos (ruling C17): `MantenimientoCronogramaProcessor` falla con
 * `UnrecoverableError` ante un nombre que no es el suyo, así que el error se
 * VE, pero lo correcto entonces es darle cola propia a uno de los dos.
 */
export const COLA_MANTENIMIENTO = 'maintenance' satisfies QueueName

/** Nombre del job repetible y del planificador (`upsertJobScheduler`) que lo genera. */
export const EVENTO_BARRIDO_RECORDATORIOS = 'schedule.reminders.sweep'

/** Cada cuánto corre el barrido. */
export const CADA_BARRIDO_MS = 10 * 60_000

/**
 * Hasta dónde mira cada barrido. Lo que empieza más allá lo cogerá un barrido
 * posterior: con una pasada cada 10 min, 48 h dan cientos de oportunidades
 * antes de que un ítem llegue a sus `−15 min`. Alternativa descartada: sin
 * tope, que reencolaría en cada pasada TODO el futuro de todos los eventos.
 */
export const VENTANA_BARRIDO_MS = 48 * 3_600_000

/**
 * Barrido periódico que reconstruye los recordatorios desde la BASE (spec
 * 2026-11-10 §5; decisión del review final de la rama): los jobs diferidos
 * viven sólo en Redis, y sin esto se pierden con un `FLUSHALL`, con una
 * caída de Redis sin persistencia o con el primer fallo de
 * `encolarRecordatorios`, que deja de intentar a propósito.
 *
 * Cubre además los huecos que los productores no ven:
 *  - la carrera recontratar / cambiar la hora: el job que encola el PATCH de
 *    la contratación puede llevar la hora vieja si el planner la cambia a la
 *    vez; el worker lo descarta por no coincidir y aquí se encola el de la
 *    hora nueva;
 *  - un evento que pasa de `DRAFT` a `ACTIVE` y un ítem que vuelve de `DONE`
 *    a `PENDING`: nadie reencola al cambiar esos estados (el worker descartó
 *    o descartaría los jobs de entonces) y el barrido los repone.
 *
 * Idempotente gracias al jobId determinista (`jobIdDeRecordatorio`: ítem,
 * contratación y hora). Si el job sigue pendiente, BullMQ ignora el segundo
 * `add` con el mismo id. Si ya se disparó, BullMQ conserva los COMPLETADOS
 * 24 h (`OPCIONES_POR_DEFECTO.removeOnComplete`) y también ignora el `add`;
 * y en cualquier caso un recordatorio que ya se disparó tiene su `−15 min`
 * en el pasado, así que `debeProgramarse` lo excluye antes de llegar a la
 * cola. Resultado: ningún aviso duplicado por barrer de más.
 *
 * Nunca lanza un error de Redis (lo absorbe `encolarRecordatorios`); uno de
 * la base sí sale, para que el job quede como fallido y se vea. El siguiente
 * barrido no depende de éste.
 *
 * No es `@Injectable`, por lo mismo que `ProgramarRecordatorios`: lo
 * construye `ScheduleModule` con `useFactory` y `reloj` sólo lo sustituyen
 * los tests.
 */
export class ReconstruirRecordatorios {
  private readonly registro = new Logger(ReconstruirRecordatorios.name)

  constructor(
    private readonly items: ScheduleItemRepository,
    private readonly cola: QueuePort,
    private readonly reloj: () => Date = () => new Date(),
  ) {}

  async ejecutar(): Promise<void> {
    const ahora = this.reloj()
    const hasta = new Date(ahora.getTime() + VENTANA_BARRIDO_MS)
    const asignaciones = await this.items.asignacionesFuturasVigentes(ahora, hasta)
    await encolarRecordatorios(this.cola, this.registro, asignaciones, ahora)
  }
}
