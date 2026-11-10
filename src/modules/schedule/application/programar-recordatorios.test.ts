import { Logger } from '@nestjs/common'

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { ANTELACION_RECORDATORIO_MS } from '../domain/participacion'
import { ScheduleItemRepositoryEnMemoria } from '../infrastructure/schedule-item.repository.fake'
import { COLA_CRONOGRAMA, EVENTO_RECORDATORIO, jobIdDeRecordatorio } from './avisos-cronograma'
import { ProgramarRecordatorios } from './programar-recordatorios'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const PLANNER_ID = '33333333-3333-4333-8333-333333333333'
const PROV_A = '55555555-5555-4555-8555-555555555555'
const EV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const AHORA = new Date('2027-06-12T18:00:00Z')
const MINUTO = 60_000

function escenario() {
  const repo = new ScheduleItemRepositoryEnMemoria()
  repo.sembrarEvento(EVENTO, { status: 'ACTIVE' })
  const contratacion = (id: string, status: 'BOOKED' | 'CANCELLED') =>
    repo.sembrarContratacion({
      id,
      eventId: EVENTO,
      userId: PROV_A,
      name: 'Ana Flores',
      categoryName: 'Flores',
      status,
    })
  contratacion(EV_A, 'BOOKED')
  contratacion(EV_B, 'BOOKED')
  const item = async (title: string, startsAt: Date, eventVendorIds = [EV_A]) => {
    const creado = await repo.crear({
      eventId: EVENTO,
      title,
      description: null,
      startsAt,
      endsAt: null,
      location: null,
      status: 'PENDING',
    })
    await repo.fijarAsignaciones(creado.id, eventVendorIds, PLANNER_ID)
    return creado
  }
  const cola = new InMemoryQueueAdapter()
  const programar = new ProgramarRecordatorios(repo, cola, () => AHORA)
  return { repo, cola, programar, item, contratacion }
}

describe('ProgramarRecordatorios', () => {
  it('Review Focus 3: al recontratar encola el recordatorio de cada asignación futura', async () => {
    const { cola, programar, item, contratacion } = escenario()
    const enUnaHora = new Date(AHORA.getTime() + 60 * MINUTO)
    const enDosHoras = new Date(AHORA.getTime() + 120 * MINUTO)
    const tarde = await item('Banquete', enDosHoras)
    const pronto = await item('Ceremonia', enUnaHora)
    await item('Ensayo', new Date(AHORA.getTime() - 60 * MINUTO))
    await item('De otro proveedor', enUnaHora, [EV_B])
    // Cancelada: el worker descartó sus jobs. Vuelve a BOOKED.
    contratacion(EV_A, 'CANCELLED')
    contratacion(EV_A, 'BOOKED')

    await programar.reprogramarContratacion(EV_A)

    expect(cola.encolados).toEqual([
      {
        cola: COLA_CRONOGRAMA,
        nombre: EVENTO_RECORDATORIO,
        datos: { itemId: pronto.id, eventVendorId: EV_A, startsAt: enUnaHora.toISOString() },
        jobId: jobIdDeRecordatorio(pronto.id, EV_A, enUnaHora),
        opciones: {
          jobId: jobIdDeRecordatorio(pronto.id, EV_A, enUnaHora),
          delayMs: 60 * MINUTO - ANTELACION_RECORDATORIO_MS,
        },
      },
      {
        cola: COLA_CRONOGRAMA,
        nombre: EVENTO_RECORDATORIO,
        datos: { itemId: tarde.id, eventVendorId: EV_A, startsAt: enDosHoras.toISOString() },
        jobId: jobIdDeRecordatorio(tarde.id, EV_A, enDosHoras),
        opciones: {
          jobId: jobIdDeRecordatorio(tarde.id, EV_A, enDosHoras),
          delayMs: 120 * MINUTO - ANTELACION_RECORDATORIO_MS,
        },
      },
    ])
  })

  it('un ítem futuro a 15 minutos o menos no se programa: el aviso ya no sería "antes"', async () => {
    const { cola, programar, item } = escenario()
    await item('Ya casi', new Date(AHORA.getTime() + ANTELACION_RECORDATORIO_MS))

    await programar.reprogramarContratacion(EV_A)

    expect(cola.encolados).toEqual([])
  })

  it('una contratación que sigue cancelada no programa nada', async () => {
    const { cola, programar, item, contratacion } = escenario()
    await item('Ceremonia', new Date(AHORA.getTime() + 60 * MINUTO))
    contratacion(EV_A, 'CANCELLED')

    await programar.reprogramarContratacion(EV_A)

    expect(cola.encolados).toEqual([])
  })

  it('nunca lanza: si la lectura falla, se registra y el PATCH ya guardado sigue', async () => {
    const { repo, cola, programar } = escenario()
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repo, 'asignacionesFuturas').mockRejectedValue(new Error('base de datos caída'))

    await expect(programar.reprogramarContratacion(EV_A)).resolves.toBeUndefined()

    expect(cola.encolados).toEqual([])
    expect(aviso).toHaveBeenCalled()
    aviso.mockRestore()
  })

  it('nunca lanza: si Redis falla, se registra', async () => {
    const { cola, programar, item } = escenario()
    await item('Ceremonia', new Date(AHORA.getTime() + 60 * MINUTO))
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    vi.spyOn(cola, 'enqueue').mockRejectedValue(new Error('redis caído'))

    await expect(programar.reprogramarContratacion(EV_A)).resolves.toBeUndefined()

    expect(aviso).toHaveBeenCalled()
    aviso.mockRestore()
  })
})
