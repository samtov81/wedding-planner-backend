import { Inject, Injectable } from '@nestjs/common'

import {
  EVENT_REPOSITORY,
  type EventRepository,
} from '@/modules/events/application/event.repository'
import { NotFoundError } from '@/shared/domain'

import { componerDocumento, fechaDeBodaIso } from './pdf-cronograma'
import { GENERADOR_PDF, type GeneradorPdf } from './pdf.port'
import { SCHEDULE_ITEM_REPOSITORY, type ScheduleItemRepository } from './schedule-item.repository'

@Injectable()
export class DescargarPdfUseCase {
  constructor(
    @Inject(SCHEDULE_ITEM_REPOSITORY) private readonly items: ScheduleItemRepository,
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Inject(GENERADOR_PDF) private readonly generador: GeneradorPdf,
  ) {}

  /**
   * Las notas se consultan SÓLO si `esPlanner` (spec 2026-11-10 §7–§8): para
   * los demás ni se leen de la base, y `componerDocumento` recibe `null`. Con
   * `esPlanner` van todas las del evento en UNA consulta (`listarNotasDeEvento`),
   * no una por ítem. El 404 repite el código y el mensaje del guard de eventos
   * (`NOT_FOUND`), que no distingue "no existe" de "no es tuyo"; en la práctica
   * el guard ya lo habrá frenado antes. Sin `weddingDate` el fichero se llama
   * `timeline.pdf`; con ella, `timeline-<YYYY-MM-DD>.pdf` con la fecha de
   * calendario tal cual (en UTC, ver `fechaDeBodaIso`), nunca en la zona del
   * evento, que la adelantaría un día al oeste de UTC.
   */
  async ejecutar(
    eventId: string,
    esPlanner: boolean,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const evento = await this.eventos.buscarPorId(eventId)
    if (evento === null) throw new NotFoundError('El evento no existe', 'NOT_FOUND')
    const items = await this.items.listarConAsignaciones(eventId)
    const notas = esPlanner ? await this.items.listarNotasDeEvento(eventId) : null
    const buffer = await this.generador.generar(componerDocumento(evento, items, notas))
    const filename =
      evento.weddingDate === null
        ? 'timeline.pdf'
        : `timeline-${fechaDeBodaIso(evento.weddingDate)}.pdf`
    return { buffer, filename }
  }
}
