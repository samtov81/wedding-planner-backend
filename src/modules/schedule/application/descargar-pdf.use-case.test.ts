import type { EventRepository } from '@/modules/events/application/event.repository'
import type { Event } from '@/modules/events/domain/event'
import { NotFoundError } from '@/shared/domain'

import { textoDelPdf } from '../../../../test/support/texto-pdf'
import { PdfkitCronograma } from '../infrastructure/pdfkit-cronograma'
import { ScheduleItemRepositoryEnMemoria } from '../infrastructure/schedule-item.repository.fake'
import { DescargarPdfUseCase } from './descargar-pdf.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const AUTOR = '22222222-2222-4222-8222-222222222222'
const NOTA = 'Confirmar el cable del DJ'

/** `weddingDate` es una fecha de calendario: Prisma la entrega a medianoche UTC. */
async function montar(weddingDate: Date | null = new Date('2027-06-12T00:00:00Z')) {
  const items = new ScheduleItemRepositoryEnMemoria()
  items.sembrarUsuario({ id: AUTOR, name: 'Marta' })
  const item = await items.crear({
    eventId: EVENTO,
    title: 'Ceremonia',
    description: null,
    startsAt: new Date('2027-06-12T21:00:00Z'),
    endsAt: null,
    location: null,
    status: 'PENDING',
  })
  await items.crearNota(item.id, AUTOR, NOTA)
  const eventos = {
    buscarPorId: (id: string) =>
      Promise.resolve(
        id === EVENTO
          ? ({ id, name: 'Boda', weddingDate, timezone: 'America/Bogota' } as unknown as Event)
          : null,
      ),
  } as unknown as EventRepository
  const caso = new DescargarPdfUseCase(items, eventos, new PdfkitCronograma({ compress: false }))
  return { caso, items }
}

describe('DescargarPdfUseCase', () => {
  it('el planner recibe un PDF con las notas', async () => {
    const { caso } = await montar()
    const { buffer } = await caso.ejecutar(EVENTO, true)
    expect(textoDelPdf(buffer)).toContain(NOTA)
  })

  it('quien no es planner recibe un PDF sin una sola nota y sin consultarlas', async () => {
    const { caso, items } = await montar()
    const consultar = vi.spyOn(items, 'listarNotasDeEvento')
    const { buffer } = await caso.ejecutar(EVENTO, false)
    expect(textoDelPdf(buffer)).not.toContain('cable del DJ')
    expect(textoDelPdf(buffer)).toContain('Ceremonia') // que el extractor sí lee el PDF
    expect(consultar).not.toHaveBeenCalled()
  })

  it('llama al fichero con la fecha de calendario de la boda, aunque la zona esté al oeste de UTC', async () => {
    const { caso } = await montar()
    // 00:00Z del 12 es el 11 a las 19:00 en Bogotá (UTC-5): leída en la zona del
    // evento, el fichero se llamaría timeline-2027-06-11.pdf.
    expect((await caso.ejecutar(EVENTO, false)).filename).toBe('timeline-2027-06-12.pdf')
  })

  it('sin fecha de boda el fichero se llama timeline.pdf', async () => {
    const { caso } = await montar(null)
    expect((await caso.ejecutar(EVENTO, false)).filename).toBe('timeline.pdf')
  })

  it('un evento que no existe da 404', async () => {
    const { caso } = await montar()
    await expect(
      caso.ejecutar('33333333-3333-4333-8333-333333333333', true),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
