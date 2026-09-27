import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { ScheduleItemRepository } from '../application/schedule-item.repository'
import { ItemDeCronogramaNoEncontradoError } from '../domain/schedule-errors'
import { ScheduleItemRepositoryEnMemoria } from './schedule-item.repository.fake'
import { PrismaScheduleItemRepository } from './prisma-schedule-item.repository'

const LUGAR = { name: 'Salón', address: 'Cra 7 #1', lat: 4.6, lng: -74.07, mapboxId: 'poi.2' }

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto. Lo que no puede compararse (ids, timestamps) se excluye con
 * `sinVolatiles`.
 */
describe('Paridad: ScheduleItemRepositoryEnMemoria vs PrismaScheduleItemRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let eventoA: string
  let eventoB: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const owner = await prisma.user.create({
      data: { email: 'owner@paridad-schedule.test', passwordHash: 'x', fullName: 'Owner' },
    })
    const eventos = await Promise.all([
      prisma.event.create({ data: { name: 'Boda A', ownerId: owner.id } }),
      prisma.event.create({ data: { name: 'Boda B', ownerId: owner.id } }),
    ])
    eventoA = eventos[0].id
    eventoB = eventos[1].id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function sujetos(): Array<[string, ScheduleItemRepository]> {
    return [
      ['doble', new ScheduleItemRepositoryEnMemoria()],
      ['prisma', new PrismaScheduleItemRepository(prisma as unknown as PrismaService)],
    ]
  }

  const sinVolatiles = ({
    id: _id,
    eventId: _e,
    createdAt: _c,
    updatedAt: _u,
    ...resto
  }: Record<string, unknown>) => resto

  it('crea con y sin location', async () => {
    for (const [, repo] of sujetos()) {
      const conLugar = sinVolatiles({
        ...(await repo.crear({
          eventId: eventoA,
          title: 'Ceremonia',
          description: null,
          startsAt: new Date('2027-06-12T18:00:00Z'),
          endsAt: null,
          location: LUGAR,
          status: 'PENDING',
        })),
      })
      expect(conLugar).toEqual({
        title: 'Ceremonia',
        description: null,
        startsAt: new Date('2027-06-12T18:00:00Z'),
        endsAt: null,
        location: LUGAR,
        status: 'PENDING',
      })

      const sinLugar = sinVolatiles({
        ...(await repo.crear({
          eventId: eventoA,
          title: 'Fiesta',
          description: 'Con DJ',
          startsAt: new Date('2027-06-12T22:00:00Z'),
          endsAt: new Date('2027-06-13T02:00:00Z'),
          location: null,
          status: 'PENDING',
        })),
      })
      expect(sinLugar).toEqual({
        title: 'Fiesta',
        description: 'Con DJ',
        startsAt: new Date('2027-06-12T22:00:00Z'),
        endsAt: new Date('2027-06-13T02:00:00Z'),
        location: null,
        status: 'PENDING',
      })
    }
  })

  it('lista tres ítems ordenados por hora', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = repo instanceof ScheduleItemRepositoryEnMemoria ? eventoA : eventoB
      await repo.crear({
        eventId: evento,
        title: 'Fiesta',
        description: null,
        startsAt: new Date('2027-07-01T22:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })
      await repo.crear({
        eventId: evento,
        title: 'Ceremonia',
        description: null,
        startsAt: new Date('2027-07-01T18:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })
      await repo.crear({
        eventId: evento,
        title: 'Recepción',
        description: null,
        startsAt: new Date('2027-07-01T20:00:00Z'),
        endsAt: null,
        location: LUGAR,
        status: 'PENDING',
      })

      const lista = await repo.listarPorEvento(evento)
      resultados.push(
        lista.map((i) => ({
          title: i.title,
          startsAt: i.startsAt,
          status: i.status,
          location: i.location,
        })),
      )
    }
    expect(resultados[0]).toEqual([
      {
        title: 'Ceremonia',
        startsAt: new Date('2027-07-01T18:00:00Z'),
        status: 'PENDING',
        location: null,
      },
      {
        title: 'Recepción',
        startsAt: new Date('2027-07-01T20:00:00Z'),
        status: 'PENDING',
        location: LUGAR,
      },
      {
        title: 'Fiesta',
        startsAt: new Date('2027-07-01T22:00:00Z'),
        status: 'PENDING',
        location: null,
      },
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar con location: null y status: IN_PROGRESS', async () => {
    for (const [, repo] of sujetos()) {
      const creado = await repo.crear({
        eventId: eventoA,
        title: 'Brindis',
        description: null,
        startsAt: new Date('2027-08-01T20:00:00Z'),
        endsAt: null,
        location: LUGAR,
        status: 'PENDING',
      })

      const actualizado = sinVolatiles({
        ...(await repo.actualizar(eventoA, creado.id, { location: null, status: 'IN_PROGRESS' })),
      })
      expect(actualizado).toEqual({
        title: 'Brindis',
        description: null,
        startsAt: new Date('2027-08-01T20:00:00Z'),
        endsAt: null,
        location: null,
        status: 'IN_PROGRESS',
      })
    }
  })

  it('actualizar sobre otro evento lanza ItemDeCronogramaNoEncontradoError', async () => {
    for (const [, repo] of sujetos()) {
      const creado = await repo.crear({
        eventId: eventoA,
        title: 'Solo en A',
        description: null,
        startsAt: new Date('2027-09-01T20:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })

      await expect(repo.actualizar(eventoB, creado.id, { title: 'X' })).rejects.toBeInstanceOf(
        ItemDeCronogramaNoEncontradoError,
      )
    }
  })

  it('eliminar devuelve true y luego false', async () => {
    for (const [, repo] of sujetos()) {
      const creado = await repo.crear({
        eventId: eventoA,
        title: 'Para borrar',
        description: null,
        startsAt: new Date('2027-10-01T20:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })

      expect(await repo.eliminar(eventoA, creado.id)).toBe(true)
      expect(await repo.eliminar(eventoA, creado.id)).toBe(false)
    }
  })
})
