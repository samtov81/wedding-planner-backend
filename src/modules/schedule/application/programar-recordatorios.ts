import { Logger } from '@nestjs/common'

import type { QueuePort } from '@/modules/queue/application/queue.port'

import { encolarRecordatorios } from './avisos-cronograma'
import type { RecordatoriosPort } from './recordatorios.port'
import type { ScheduleItemRepository } from './schedule-item.repository'

/**
 * Reprograma los recordatorios de una contratación que vuelve a `BOOKED`
 * (spec 2026-11-10 §5, "Recontratación"; Review Focus 3).
 *
 * Mientras estuvo cancelada, sus jobs llegaron al worker y se descartaron
 * (`destinoRecordatorio` da null) o siguen esperando en Redis. Aquí se
 * encola UNO por asignación vigente con `startsAt` futuro, con el MISMO jobId
 * determinista (`jobIdDeRecordatorio`). Si el job de antes sigue pendiente,
 * BullMQ ignora el nuevo y el pendiente avisará a su hora, ya con la
 * contratación vigente. Si ya se consumió, es que llegó su `−15 min`: ese
 * recordatorio ya no se puede dar a tiempo y `debeProgramarse` lo excluye,
 * así que no hay nada que reponer. Lo que este paso SÍ aporta es el job de
 * una hora que cambió mientras la contratación estaba cancelada (nadie lo
 * encoló entonces porque no era vigente): otra hora, otro jobId.
 * Alternativa descartada: guardar en la base qué jobs se descartaron para
 * reponer sólo ésos; el jobId ya hace ese trabajo sin estado nuevo.
 * El barrido periódico (`ReconstruirRecordatorios`) cubre lo que esto no
 * alcance (Redis caído en este momento, una carrera con un cambio de hora).
 *
 * Se llama después del commit del PATCH y NUNCA lanza: un fallo al leer o al
 * encolar se registra. El PATCH ya está guardado y deshacerlo por un aviso
 * sería peor (mismo criterio que `encolarRecordatorios`).
 *
 * No es `@Injectable`: `ScheduleRemindersModule` lo construye con
 * `useFactory`, y así `reloj` puede ser un parámetro normal con valor por
 * defecto que sólo los tests sustituyen. Con inyección por clase, Nest
 * intentaría resolver ese parámetro como un proveedor (`Function`).
 */
export class ProgramarRecordatorios implements RecordatoriosPort {
  private readonly registro = new Logger(ProgramarRecordatorios.name)

  constructor(
    private readonly items: ScheduleItemRepository,
    private readonly cola: QueuePort,
    private readonly reloj: () => Date = () => new Date(),
  ) {}

  async reprogramarContratacion(eventVendorId: string): Promise<void> {
    const ahora = this.reloj()
    let futuras: { itemId: string; startsAt: Date }[]
    try {
      futuras = await this.items.asignacionesFuturas(eventVendorId, ahora)
    } catch (error) {
      this.registro.warn(
        `Recordatorios sin reprogramar eventVendorId=${eventVendorId}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
      return
    }
    await encolarRecordatorios(
      this.cola,
      this.registro,
      futuras.map((f) => ({ ...f, eventVendorId })),
      ahora,
    )
  }
}
