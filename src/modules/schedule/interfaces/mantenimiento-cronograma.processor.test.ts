import { UnrecoverableError, type Job } from 'bullmq'

import {
  CADA_BARRIDO_MS,
  COLA_MANTENIMIENTO,
  EVENTO_BARRIDO_RECORDATORIOS,
  type ReconstruirRecordatorios,
} from '../application/reconstruir-recordatorios'
import { MantenimientoCronogramaProcessor } from './mantenimiento-cronograma.processor'

/** Clave de metadata de `@Processor` (no exportada por `@nestjs/bullmq`). */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'

const job = (name: string): Job => ({ name, data: {} }) as Job

function montar() {
  const ejecutar = vi.fn(() => Promise.resolve())
  const upsertJobScheduler = vi.fn(() => Promise.resolve({} as Job))
  const procesador = new MantenimientoCronogramaProcessor(
    { ejecutar } as unknown as ReconstruirRecordatorios,
    { upsertJobScheduler },
  )
  return { procesador, ejecutar, upsertJobScheduler }
}

describe('MantenimientoCronogramaProcessor', () => {
  it('escucha la cola maintenance', () => {
    expect(Reflect.getMetadata(PROCESSOR_METADATA, MantenimientoCronogramaProcessor)).toMatchObject(
      {
        name: COLA_MANTENIMIENTO,
      },
    )
  })

  it('al arrancar registra UN planificador de id fijo cada 10 minutos', async () => {
    const { procesador, upsertJobScheduler } = montar()
    await procesador.onApplicationBootstrap()
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      EVENTO_BARRIDO_RECORDATORIOS,
      { every: CADA_BARRIDO_MS },
      expect.objectContaining({ name: EVENTO_BARRIDO_RECORDATORIOS }),
    )
    expect(CADA_BARRIDO_MS).toBe(600_000)
  })

  it('el job del barrido ejecuta ReconstruirRecordatorios', async () => {
    const { procesador, ejecutar } = montar()
    await procesador.process(job(EVENTO_BARRIDO_RECORDATORIOS))
    expect(ejecutar).toHaveBeenCalledTimes(1)
  })

  it('un job desconocido falla sin reintentos y no barre', async () => {
    const { procesador, ejecutar } = montar()
    await expect(procesador.process(job('otra.cosa'))).rejects.toBeInstanceOf(UnrecoverableError)
    expect(ejecutar).not.toHaveBeenCalled()
  })
})
