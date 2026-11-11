import { Processor, WorkerHost } from '@nestjs/bullmq'
import type { OnApplicationBootstrap } from '@nestjs/common'
import { type Job, type Queue, UnrecoverableError } from 'bullmq'

import {
  CADA_BARRIDO_MS,
  COLA_MANTENIMIENTO,
  EVENTO_BARRIDO_RECORDATORIOS,
  type ReconstruirRecordatorios,
} from '../application/reconstruir-recordatorios'

/** Lo único que este worker usa de la `Queue` de BullMQ: registrar el planificador. */
export type PlanificadorDeJobs = Pick<Queue, 'upsertJobScheduler'>

/**
 * Worker de la cola `maintenance` y dueño del job repetible que la alimenta:
 * cada `CADA_BARRIDO_MS` (10 min) ejecuta `ReconstruirRecordatorios`.
 *
 * El planificador se registra al arrancar (`onApplicationBootstrap`) con
 * `upsertJobScheduler` y un id FIJO: con varias instancias o reinicios, todas
 * hacen upsert del MISMO planificador en Redis y sale un solo job por
 * intervalo, no uno por proceso. Con `every`, BullMQ lanza la primera pasada
 * en cuanto se registra, así que arrancar la app también reconstruye lo que
 * se perdiera estando parada. Alternativa descartada: un `setInterval` en el
 * proceso, que con N réplicas barrería N veces y no sobrevive a un reinicio
 * a mitad de intervalo de forma coordinada.
 *
 * Un fallo al registrar se deja salir: el arranque falla, como cuando Redis
 * no está para el resto de colas. Un nombre de job desconocido falla con
 * `UnrecoverableError` (retornar lo marcaría completado y lo perdería, que
 * es el riesgo de compartir esta cola; ver `COLA_MANTENIMIENTO`).
 *
 * Se construye con `useFactory` en `ScheduleModule`, como `ScheduleProcessor`.
 */
@Processor(COLA_MANTENIMIENTO)
export class MantenimientoCronogramaProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly reconstruir: ReconstruirRecordatorios,
    private readonly planificador: PlanificadorDeJobs,
  ) {
    super()
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.planificador.upsertJobScheduler(
      EVENTO_BARRIDO_RECORDATORIOS,
      { every: CADA_BARRIDO_MS },
      {
        name: EVENTO_BARRIDO_RECORDATORIOS,
        // 144 pasadas al día: sin tope, Redis guardaría cada una para siempre.
        opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
      },
    )
  }

  async process(job: Job): Promise<void> {
    if (job.name !== EVENTO_BARRIDO_RECORDATORIOS) {
      throw new UnrecoverableError(`Job desconocido en la cola maintenance: ${job.name}`)
    }
    await this.reconstruir.ejecutar()
  }
}
