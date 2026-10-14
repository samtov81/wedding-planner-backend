import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { EventRepository } from '../application/event.repository'
import { EventRepositoryEnMemoria } from './event.repository.fake'
import { PrismaEventRepository } from './prisma-event.repository'

const VENUE = {
  name: 'Hacienda',
  address: 'Km 5 vía La Calera',
  lat: 4.712345,
  lng: -73.912345,
  mapboxId: 'poi.1',
}

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto (ruling H1). Lo que no puede compararse (ids, timestamps) se
 * excluye con `sinVolatiles`.
 */
describe('Paridad: EventRepositoryEnMemoria vs PrismaEventRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let ownerId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const owner = await prisma.user.create({
      data: { email: 'owner@paridad.test', passwordHash: 'x', fullName: 'Owner' },
    })
    ownerId = owner.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function sujetos(): Array<[string, EventRepository]> {
    return [
      ['doble', new EventRepositoryEnMemoria()],
      ['prisma', new PrismaEventRepository(prisma as unknown as PrismaService)],
    ]
  }

  const sinVolatiles = ({
    id: _id,
    createdAt: _c,
    updatedAt: _u,
    ownerId: _o,
    ...resto
  }: Record<string, unknown>) => resto

  it('crea un borrador solo con nombre, con los defaults de la columna', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      resultados.push(
        sinVolatiles({ ...(await repo.crearConMembresia({ name: 'Boda', ownerId })) }),
      )
    }
    expect(resultados[0]).toEqual({
      name: 'Boda',
      status: 'DRAFT',
      weddingDate: null,
      timezone: 'UTC',
      currency: 'USD',
      totalBudget: null,
      venue: null,
      rsvpDeadlineDays: 14,
      conteos: { scheduleItems: 0, vendors: 0 },
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('crea con todos los campos y los devuelve normalizados', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        weddingDate: new Date('2027-06-12T00:00:00Z'),
        timezone: 'America/Bogota',
        currency: 'COP',
        totalBudget: '45000000.00',
        venue: VENUE,
      })
      resultados.push(sinVolatiles({ ...evento }))
    }
    expect(resultados[0]).toMatchObject({
      totalBudget: '45000000.00',
      venue: VENUE,
      currency: 'COP',
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar aplica solo lo que llega y null borra', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const creado = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        totalBudget: '100.00',
        venue: VENUE,
      })
      const actualizado = await repo.actualizar(creado.id, {
        name: 'Boda de Ana',
        venue: null,
        weddingDate: new Date('2027-01-01T00:00:00Z'),
      })
      resultados.push(sinVolatiles({ ...actualizado }))
    }
    expect(resultados[0]).toMatchObject({
      name: 'Boda de Ana',
      venue: null,
      totalBudget: '100.00',
      weddingDate: new Date('2027-01-01T00:00:00Z'),
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar un evento inexistente lanza EventoNoEncontradoError', async () => {
    for (const [, repo] of sujetos()) {
      await expect(
        repo.actualizar('00000000-0000-4000-8000-000000000000', { name: 'X' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
  })

  it('publicarSiCompleto publica un DRAFT completo y es null si le falta algo o ya no es DRAFT', async () => {
    for (const [, repo] of sujetos()) {
      const completo = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        weddingDate: new Date('2027-06-12T00:00:00Z'),
        totalBudget: '100.00',
        venue: VENUE,
      })
      const publicado = await repo.publicarSiCompleto(completo.id)
      expect(publicado?.status).toBe('ACTIVE')
      // Ya no es DRAFT: una segunda llamada no hace nada.
      expect(await repo.publicarSiCompleto(completo.id)).toBeNull()

      const incompleto = await repo.crearConMembresia({ name: 'Boda a medias', ownerId })
      expect(await repo.publicarSiCompleto(incompleto.id)).toBeNull()
      expect((await repo.buscarPorId(incompleto.id))?.status).toBe('DRAFT')
    }
  })

  it('buscarMembresiaActiva marca owner sólo para quien creó el evento', async () => {
    const otro = await prisma.user.create({
      data: { email: 'pareja-2@paridad.test', passwordHash: 'x', fullName: 'Pareja 2' },
    })
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      if (repo instanceof EventRepositoryEnMemoria) {
        repo.membresias.push({
          eventId: evento.id,
          userId: otro.id,
          role: 'COUPLE',
          status: 'ACTIVE',
        })
      } else {
        await prisma.eventMembership.create({
          data: { eventId: evento.id, userId: otro.id, role: 'COUPLE', status: 'ACTIVE' },
        })
      }

      expect(await repo.buscarMembresiaActiva(evento.id, ownerId), nombre).toEqual({
        role: 'COUPLE',
        owner: true,
        budgetView: false,
      })
      expect(await repo.buscarMembresiaActiva(evento.id, otro.id), nombre).toEqual({
        role: 'COUPLE',
        owner: false,
        budgetView: false,
      })
    }
  })

  it('buscarMembresiaActiva lee el grant de presupuesto en la misma consulta', async () => {
    const otro = await prisma.user.create({
      data: { email: `grant-${Date.now()}@paridad.test`, passwordHash: 'x', fullName: 'Con grant' },
    })
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      if (repo instanceof EventRepositoryEnMemoria) {
        repo.membresias.push({
          id: `m-${nombre}`,
          eventId: evento.id,
          userId: otro.id,
          role: 'PLANNER',
          status: 'ACTIVE',
          budgetView: true,
        })
      } else {
        const m = await prisma.eventMembership.create({
          data: { eventId: evento.id, userId: otro.id, role: 'PLANNER', status: 'ACTIVE' },
        })
        await prisma.eventBudgetGrant.create({ data: { membershipId: m.id, grantedById: ownerId } })
      }
      expect(await repo.buscarMembresiaActiva(evento.id, otro.id), nombre).toEqual({
        role: 'PLANNER',
        owner: false,
        budgetView: true,
      })
    }
  })

  it('listarAccesiblesPor devuelve el grant de quien pregunta en cada evento', async () => {
    const miembro = await prisma.user.create({
      data: { email: `lista-${Date.now()}@paridad.test`, passwordHash: 'x', fullName: 'Lista' },
    })
    for (const [nombre, repo] of sujetos()) {
      const conGrant = await repo.crearConMembresia({ name: 'Con grant', ownerId })
      const sinGrant = await repo.crearConMembresia({ name: 'Sin grant', ownerId })
      for (const [evento, budgetView] of [
        [conGrant, true],
        [sinGrant, false],
      ] as const) {
        if (repo instanceof EventRepositoryEnMemoria) {
          repo.membresias.push({
            id: `${nombre}-${evento.id}`,
            eventId: evento.id,
            userId: miembro.id,
            role: 'COUPLE',
            status: 'ACTIVE',
            budgetView,
          })
        } else {
          const m = await prisma.eventMembership.create({
            data: { eventId: evento.id, userId: miembro.id, role: 'COUPLE', status: 'ACTIVE' },
          })
          if (budgetView) {
            await prisma.eventBudgetGrant.create({
              data: { membershipId: m.id, grantedById: ownerId },
            })
          }
        }
      }
      const lista = await repo.listarAccesiblesPor(miembro.id)
      const porNombre = Object.fromEntries(lista.map((a) => [a.evento.name, a.budgetView]))
      expect(porNombre, nombre).toMatchObject({ 'Con grant': true, 'Sin grant': false })
    }
  })
})
