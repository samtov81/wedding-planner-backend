import { Logger } from '@nestjs/common'

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { ANTELACION_RECORDATORIO_MS } from '../domain/participacion'
import { encolarRecordatorios, jobIdDeRecordatorio } from './avisos-cronograma'

const AHORA = new Date('2027-06-12T18:00:00Z')
const HORA = 3_600_000

const asignacion = (n: number, startsAt: Date) => ({
  itemId: `item-${n}`,
  eventVendorId: `ev-${n}`,
  startsAt,
})

describe('encolarRecordatorios', () => {
  it('encola sólo las que aún pueden avisar, con el retraso hasta startsAt − 15 min', async () => {
    const cola = new InMemoryQueueAdapter()
    const futura = new Date(AHORA.getTime() + HORA)
    await encolarRecordatorios(
      cola,
      new Logger('test'),
      [
        asignacion(1, futura),
        asignacion(2, new Date(AHORA.getTime() + ANTELACION_RECORDATORIO_MS)),
        asignacion(3, new Date(AHORA.getTime() - HORA)),
      ],
      AHORA,
    )
    expect(cola.encolados.map((e) => [e.jobId, e.opciones.delayMs])).toEqual([
      [jobIdDeRecordatorio('item-1', 'ev-1', futura), HORA - ANTELACION_RECORDATORIO_MS],
    ])
  })

  it('al primer fallo de Redis deja de intentar y lo registra UNA vez con cuántos omite', async () => {
    const cola = new InMemoryQueueAdapter()
    const encolar = vi.spyOn(cola, 'enqueue').mockRejectedValue(new Error('redis caído'))
    const registro = new Logger('test')
    const aviso = vi.spyOn(registro, 'warn').mockImplementation(() => undefined)
    const futura = new Date(AHORA.getTime() + HORA)

    await expect(
      encolarRecordatorios(
        cola,
        registro,
        [
          asignacion(1, futura),
          asignacion(2, futura),
          // La pasada no cuenta como omitida: nunca se habría encolado.
          asignacion(3, new Date(AHORA.getTime() - HORA)),
          asignacion(4, futura),
        ],
        AHORA,
      ),
    ).resolves.toBeUndefined()

    expect(encolar).toHaveBeenCalledTimes(1)
    expect(aviso).toHaveBeenCalledTimes(1)
    expect(aviso.mock.calls[0]?.[0]).toContain('itemId=item-1')
    expect(aviso.mock.calls[0]?.[0]).toContain('se omiten 2 más')
  })

  it('un fallo a mitad conserva lo ya encolado y no sigue', async () => {
    const cola = new InMemoryQueueAdapter()
    const real = cola.enqueue.bind(cola)
    let llamadas = 0
    vi.spyOn(cola, 'enqueue').mockImplementation((...args) => {
      llamadas++
      return llamadas === 2 ? Promise.reject(new Error('redis caído')) : real(...args)
    })
    const registro = new Logger('test')
    vi.spyOn(registro, 'warn').mockImplementation(() => undefined)
    const futura = new Date(AHORA.getTime() + HORA)

    await encolarRecordatorios(
      cola,
      registro,
      [asignacion(1, futura), asignacion(2, futura), asignacion(3, futura)],
      AHORA,
    )

    expect(llamadas).toBe(2)
    expect(cola.encolados.map((e) => e.jobId)).toEqual([
      jobIdDeRecordatorio('item-1', 'ev-1', futura),
    ])
  })
})
