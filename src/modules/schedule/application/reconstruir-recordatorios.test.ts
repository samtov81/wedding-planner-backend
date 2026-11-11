import { Logger } from '@nestjs/common'

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { ANTELACION_RECORDATORIO_MS } from '../domain/participacion'
import { ScheduleItemRepositoryEnMemoria } from '../infrastructure/schedule-item.repository.fake'
import { COLA_CRONOGRAMA, EVENTO_RECORDATORIO, jobIdDeRecordatorio } from './avisos-cronograma'
import { ReconstruirRecordatorios, VENTANA_BARRIDO_MS } from './reconstruir-recordatorios'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const BORRADOR = '22222222-2222-4222-8222-222222222222'
const PLANNER_ID = '33333333-3333-4333-8333-333333333333'
const PROV_A = '55555555-5555-4555-8555-555555555555'
const EV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EV_BORRADOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const AHORA = new Date('2027-06-12T18:00:00Z')
const MINUTO = 60_000
const en = (ms: number) => new Date(AHORA.getTime() + ms)

function escenario() {
  const repo = new ScheduleItemRepositoryEnMemoria()
  repo.sembrarEvento(EVENTO, { status: 'ACTIVE' })
  repo.sembrarEvento(BORRADOR, { status: 'DRAFT' })
  for (const [id, eventId] of [
    [EV_A, EVENTO],
    [EV_BORRADOR, BORRADOR],
  ] as const) {
    repo.sembrarContratacion({
      id,
      eventId,
      userId: PROV_A,
      name: 'Ana Flores',
      categoryName: 'Flores',
      status: 'BOOKED',
    })
  }
  const item = async (title: string, startsAt: Date, eventId = EVENTO, eventVendorId = EV_A) => {
    const creado = await repo.crear({
      eventId,
      title,
      description: null,
      startsAt,
      endsAt: null,
      location: null,
      status: 'PENDING',
    })
    await repo.fijarAsignaciones(creado.id, [eventVendorId], PLANNER_ID)
    return creado
  }
  const cola = new InMemoryQueueAdapter()
  const barrido = new ReconstruirRecordatorios(repo, cola, () => AHORA)
  return { repo, cola, barrido, item }
}

describe('ReconstruirRecordatorios', () => {
  it('encola desde la base lo que el worker avisaría dentro de la ventana de 48 h', async () => {
    const { cola, barrido, item } = escenario()
    const pronto = await item('Ceremonia', en(60 * MINUTO))
    const alBorde = await item('Brunch', en(VENTANA_BARRIDO_MS))
    await item('Pasado mañana y algo', en(VENTANA_BARRIDO_MS + MINUTO))
    await item('Ya pasó', en(-60 * MINUTO))
    // Su −15 min ya pasó: no se programa (y si se disparó, no se repite).
    await item('Ya casi', en(ANTELACION_RECORDATORIO_MS))

    await barrido.ejecutar()

    expect(cola.encolados.map((e) => [e.cola, e.nombre, e.jobId, e.opciones.delayMs])).toEqual([
      [
        COLA_CRONOGRAMA,
        EVENTO_RECORDATORIO,
        jobIdDeRecordatorio(pronto.id, EV_A, pronto.startsAt),
        60 * MINUTO - ANTELACION_RECORDATORIO_MS,
      ],
      [
        COLA_CRONOGRAMA,
        EVENTO_RECORDATORIO,
        jobIdDeRecordatorio(alBorde.id, EV_A, alBorde.startsAt),
        VENTANA_BARRIDO_MS - ANTELACION_RECORDATORIO_MS,
      ],
    ])
  })

  it('es idempotente: barrer dos veces deja un solo job por (ítem, contratación, hora)', async () => {
    const { cola, barrido, item } = escenario()
    await item('Ceremonia', en(60 * MINUTO))

    await barrido.ejecutar()
    await barrido.ejecutar()

    expect(cola.encolados).toHaveLength(1)
  })

  it('repone lo que los productores no reencolan: DRAFT→ACTIVE, DONE→PENDING y la hora nueva', async () => {
    const { repo, cola, barrido, item } = escenario()
    const delBorrador = await item('Ensayo', en(60 * MINUTO), BORRADOR, EV_BORRADOR)
    const hecho = await item('Montaje', en(90 * MINUTO))
    await repo.actualizar(EVENTO, hecho.id, { status: 'DONE' })
    const movido = await item('Banquete', en(120 * MINUTO))

    await barrido.ejecutar()
    expect(cola.encolados.map((e) => e.jobId)).toEqual([
      jobIdDeRecordatorio(movido.id, EV_A, movido.startsAt),
    ])

    repo.sembrarEvento(BORRADOR, { status: 'ACTIVE' })
    await repo.actualizar(EVENTO, hecho.id, { status: 'PENDING' })
    const nuevaHora = en(150 * MINUTO)
    await repo.actualizar(EVENTO, movido.id, { startsAt: nuevaHora })

    await barrido.ejecutar()
    expect(cola.encolados.map((e) => e.jobId)).toEqual([
      jobIdDeRecordatorio(movido.id, EV_A, movido.startsAt),
      jobIdDeRecordatorio(delBorrador.id, EV_BORRADOR, delBorrador.startsAt),
      jobIdDeRecordatorio(hecho.id, EV_A, hecho.startsAt),
      jobIdDeRecordatorio(movido.id, EV_A, nuevaHora),
    ])
  })

  it('un fallo de Redis no lanza (se registra); uno de la base sí, para que el job conste como fallido', async () => {
    const { repo, cola, barrido, item } = escenario()
    await item('Ceremonia', en(60 * MINUTO))
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    vi.spyOn(cola, 'enqueue').mockRejectedValue(new Error('redis caído'))
    await expect(barrido.ejecutar()).resolves.toBeUndefined()
    expect(aviso).toHaveBeenCalledTimes(1)
    aviso.mockRestore()

    vi.spyOn(repo, 'asignacionesFuturasVigentes').mockRejectedValue(new Error('base caída'))
    await expect(barrido.ejecutar()).rejects.toThrow('base caída')
  })
})
