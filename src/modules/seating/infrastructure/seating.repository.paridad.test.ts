import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { SeatingRepository } from '../application/seating.repository'
import { MesaNoEncontradaError } from '../domain/seating-errors'
import { PrismaSeatingRepository } from './prisma-seating.repository'
import { SeatingRepositoryEnMemoria } from './seating.repository.fake'

const MESA = { minSeats: 2, maxSeats: 4, seatCount: 2, x: 0, y: 0 }

/** Cada caso corre contra el doble y contra Postgres y compara lo que devuelve el puerto. */
describe('Paridad: SeatingRepositoryEnMemoria vs PrismaSeatingRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let eventoA: string
  let eventoB: string
  let invitado: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const owner = await prisma.user.create({
      data: { email: 'owner@paridad-seating.test', passwordHash: 'x', fullName: 'Owner' },
    })
    const eventos = await Promise.all([
      prisma.event.create({ data: { name: 'Boda A', ownerId: owner.id } }),
      prisma.event.create({ data: { name: 'Boda B', ownerId: owner.id } }),
    ])
    eventoA = eventos[0].id
    eventoB = eventos[1].id
    const g = await prisma.guest.create({
      data: { eventId: eventoA, name: 'Ana', group: 'Family', companionsAllowed: 2 },
    })
    invitado = g.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  async function limpiar(): Promise<void> {
    await prisma.seatingTable.deleteMany({})
  }

  function sujetos(): Array<[string, SeatingRepository]> {
    const doble = new SeatingRepositoryEnMemoria()
    doble.sembrarInvitado(eventoA, {
      id: invitado,
      rsvp: 'PENDING',
      companionsAllowed: 2,
      companionsConfirmed: null,
    })
    return [
      ['doble', doble],
      ['prisma', new PrismaSeatingRepository(prisma as unknown as PrismaService)],
    ]
  }

  it('crea mesas en orden, aun en lotes seguidos, y las cuenta por evento', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      await limpiar()
      await repo.crearMesas(eventoA, [
        { ...MESA, name: 'Mesa 1' },
        { ...MESA, name: 'Mesa 2' },
      ])
      await repo.crearMesas(eventoA, [{ ...MESA, name: 'Mesa 3' }])
      await repo.crearMesas(eventoB, [{ ...MESA, name: 'Ajena' }])
      resultados.push({
        nombres: (await repo.listarMesas(eventoA)).map((m) => m.name),
        cuenta: await repo.contarMesas(eventoA),
      })
    }
    expect(resultados[0]).toEqual({ nombres: ['Mesa 1', 'Mesa 2', 'Mesa 3'], cuenta: 3 })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualiza solo lo pedido y da 404 en otro evento', async () => {
    for (const [, repo] of sujetos()) {
      await limpiar()
      const [mesa] = await repo.crearMesas(eventoA, [{ ...MESA, name: 'Mesa 1' }])
      if (mesa === undefined) throw new Error('sin mesa')
      const cambiada = await repo.actualizarMesa(eventoA, mesa.id, { seatCount: 3, x: 50 })
      expect({ ...cambiada, id: 'x', eventId: 'x', createdAt: null }).toEqual({
        id: 'x',
        eventId: 'x',
        createdAt: null,
        name: 'Mesa 1',
        minSeats: 2,
        maxSeats: 4,
        seatCount: 3,
        x: 50,
        y: 0,
      })
      await expect(repo.actualizarMesa(eventoB, mesa.id, { x: 1 })).rejects.toBeInstanceOf(
        MesaNoEncontradaError,
      )
      expect(await repo.buscarMesa(eventoB, mesa.id)).toBeNull()
    }
  })

  it('asigna, rechaza duplicados, quita y borra en cascada con la mesa', async () => {
    for (const [nombre, repo] of sujetos()) {
      await limpiar()
      const [mesa] = await repo.crearMesas(eventoA, [{ ...MESA, name: 'Mesa 1' }])
      if (mesa === undefined) throw new Error('sin mesa')
      await repo.asignar(eventoA, {
        tableId: mesa.id,
        seatIndex: 0,
        guestId: invitado,
        companionIndex: 0,
      })
      await expect(
        repo.asignar(eventoA, {
          tableId: mesa.id,
          seatIndex: 0,
          guestId: invitado,
          companionIndex: 1,
        }),
        nombre,
      ).rejects.toThrow()
      await expect(
        repo.asignar(eventoA, {
          tableId: mesa.id,
          seatIndex: 1,
          guestId: invitado,
          companionIndex: 0,
        }),
        nombre,
      ).rejects.toThrow()
      await repo.asignar(eventoA, {
        tableId: mesa.id,
        seatIndex: 1,
        guestId: invitado,
        companionIndex: 1,
      })
      await repo.quitarOcupantes(eventoA, [{ guestId: invitado, companionIndex: 0 }])
      expect(await repo.listarAsignaciones(eventoA)).toEqual([
        { tableId: mesa.id, seatIndex: 1, guestId: invitado, companionIndex: 1 },
      ])
      await repo.quitarAsiento(eventoA, mesa.id, 1)
      expect(await repo.listarAsignaciones(eventoA)).toEqual([])

      await repo.asignar(eventoA, {
        tableId: mesa.id,
        seatIndex: 0,
        guestId: invitado,
        companionIndex: 0,
      })
      expect(await repo.eliminarMesa(eventoA, mesa.id)).toBe(true)
      expect(await repo.eliminarMesa(eventoA, mesa.id)).toBe(false)
      expect(await repo.listarAsignaciones(eventoA)).toEqual([])
    }
  })

  it('lee al invitado sentable solo en su evento', async () => {
    for (const [, repo] of sujetos()) {
      expect(await repo.buscarInvitado(eventoA, invitado)).toEqual({
        id: invitado,
        rsvp: 'PENDING',
        companionsAllowed: 2,
        companionsConfirmed: null,
      })
      expect(await repo.buscarInvitado(eventoB, invitado)).toBeNull()
      expect((await repo.listarInvitados(eventoA)).map((i) => i.id)).toEqual([invitado])
    }
  })

  it('bloquearEvento serializa dos transacciones sobre el mismo evento', async () => {
    const repo = new PrismaSeatingRepository(prisma as unknown as PrismaService)
    const udt = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)
    const orden: string[] = []
    let soltar: () => void = () => undefined
    const primeraDentro = new Promise<void>((r) => {
      soltar = r
    })
    const primera = udt.ejecutar(async () => {
      await repo.bloquearEvento(eventoA)
      orden.push('primera bloquea')
      soltar()
      await new Promise((r) => setTimeout(r, 300))
      orden.push('primera termina')
    })
    await primeraDentro
    const segunda = udt.ejecutar(async () => {
      await repo.bloquearEvento(eventoA)
      orden.push('segunda bloquea')
    })
    await Promise.all([primera, segunda])
    expect(orden).toEqual(['primera bloquea', 'primera termina', 'segunda bloquea'])
  })
})
