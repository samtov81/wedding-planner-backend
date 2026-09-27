import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'
import { decodeCursor } from '@/shared/domain'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { PrismaNotificationRepository } from './prisma-notification.repository'

const BASE = new Date('2026-03-01T00:00:00.000Z')

describe('PrismaNotificationRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let repo: PrismaNotificationRepository
  let eventId: string
  let otroEventId: string
  let parejaId: string
  let plannerId: string
  let invitadoAEquipoId: string
  let revocadoId: string
  let vendorId: string

  async function crearUsuario(email: string): Promise<string> {
    return (await prisma.user.create({ data: { email, passwordHash: 'x', fullName: email } })).id
  }

  /** Siembra directa, con `createdAt` controlado: el orden es lo que se prueba. */
  async function sembrar(datos: {
    userId: string
    eventId?: string
    minuto: number
    leida?: boolean
  }): Promise<string> {
    const fila = await prisma.notification.create({
      data: {
        eventId: datos.eventId ?? eventId,
        userId: datos.userId,
        type: 'guest.rsvp.updated',
        payload: { minuto: datos.minuto },
        createdAt: new Date(BASE.getTime() + datos.minuto * 60_000),
        readAt: datos.leida === true ? BASE : null,
      },
    })
    return fila.id
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    repo = new PrismaNotificationRepository(prisma as unknown as PrismaService)

    parejaId = await crearUsuario('pareja@test.com')
    plannerId = await crearUsuario('planner@test.com')
    invitadoAEquipoId = await crearUsuario('invitado-al-equipo@test.com')
    revocadoId = await crearUsuario('revocado@test.com')
    vendorId = await crearUsuario('vendor@test.com')

    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12T00:00:00.000Z'), ownerId: parejaId },
    })
    const otro = await prisma.event.create({
      data: { name: 'Otra', weddingDate: new Date('2027-07-12T00:00:00.000Z'), ownerId: parejaId },
    })
    eventId = evento.id
    otroEventId = otro.id
    await prisma.eventMembership.createMany({
      data: [
        { eventId, userId: parejaId, role: 'COUPLE', status: 'ACTIVE' },
        { eventId, userId: plannerId, role: 'PLANNER', status: 'ACTIVE' },
        { eventId, userId: invitadoAEquipoId, role: 'PLANNER', status: 'INVITED' },
        { eventId, userId: revocadoId, role: 'PLANNER', status: 'REVOKED' },
      ],
    })
    const perfil = await prisma.vendorProfile.create({
      data: { userId: vendorId, businessName: 'Catering', category: 'CATERING' },
    })
    await prisma.eventVendor.create({
      data: { eventId, vendorProfileId: perfil.id, category: 'CATERING', status: 'BOOKED' },
    })
  }, 240_000)

  beforeEach(async () => {
    await prisma.notification.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  describe('crearParaMiembros', () => {
    it('crea UNA por miembro ACTIVO; ni INVITED, ni REVOKED, ni el vendor contratado', async () => {
      await repo.crearParaMiembros(eventId, 'guest.rsvp.updated', { guestId: 'g-1' })

      const filas = await prisma.notification.findMany()
      expect(filas.map((f) => f.userId).sort()).toEqual([parejaId, plannerId].sort())
      for (const fila of filas) {
        expect(fila).toMatchObject({
          eventId,
          type: 'guest.rsvp.updated',
          payload: { guestId: 'g-1' },
          readAt: null,
        })
      }
    })

    it('guarda el payload como JSON: un Date llega como texto', async () => {
      await repo.crearParaMiembros(eventId, 't', { cuando: new Date('2026-01-02T03:04:05.000Z') })

      const fila = await prisma.notification.findFirstOrThrow()
      expect(fila.payload).toEqual({ cuando: '2026-01-02T03:04:05.000Z' })
    })

    it('rechaza un payload que no es JSON, como el doble', async () => {
      await expect(repo.crearParaMiembros(eventId, 't', undefined)).rejects.toThrow(/JSON/)
    })

    it('escribe DENTRO de la unidad de trabajo: si ésta se deshace, no queda ninguna', async () => {
      const unidad = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)

      await expect(
        unidad.ejecutar(async () => {
          await repo.crearParaMiembros(eventId, 'guest.rsvp.updated', { guestId: 'g-1' })
          throw new Error('fallo después de notificar')
        }),
      ).rejects.toThrow('fallo después de notificar')

      expect(await prisma.notification.count()).toBe(0)
    })
  })

  describe('listar', () => {
    it('sólo las del usuario en ESTE evento, las más recientes primero', async () => {
      const vieja = await sembrar({ userId: parejaId, minuto: 1 })
      const nueva = await sembrar({ userId: parejaId, minuto: 2 })
      await sembrar({ userId: plannerId, minuto: 3 })
      await sembrar({ userId: parejaId, eventId: otroEventId, minuto: 4 })

      const pagina = await repo.listar(eventId, parejaId, {
        desde: null,
        limite: 10,
        soloNoLeidas: false,
      })

      expect(pagina.items.map((n) => n.id)).toEqual([nueva, vieja])
      expect(pagina.nextCursor).toBeNull()
    })

    it('pagina por cursor sin saltar ni repetir, con createdAt empatados', async () => {
      const ids: string[] = []
      for (let i = 0; i < 5; i += 1) ids.push(await sembrar({ userId: parejaId, minuto: i % 2 }))

      const vistas: string[] = []
      let desde = null
      for (let vuelta = 0; vuelta < 10; vuelta += 1) {
        const pagina = await repo.listar(eventId, parejaId, {
          desde,
          limite: 2,
          soloNoLeidas: false,
        })
        vistas.push(...pagina.items.map((n) => n.id))
        if (pagina.nextCursor === null) break
        desde = decodeCursor(pagina.nextCursor)
      }

      expect(vistas).toHaveLength(5)
      expect(new Set(vistas)).toEqual(new Set(ids))
    })

    it('soloNoLeidas deja fuera las leídas', async () => {
      await sembrar({ userId: parejaId, minuto: 1, leida: true })
      const noLeida = await sembrar({ userId: parejaId, minuto: 2 })

      const pagina = await repo.listar(eventId, parejaId, {
        desde: null,
        limite: 10,
        soloNoLeidas: true,
      })

      expect(pagina.items.map((n) => n.id)).toEqual([noLeida])
    })
  })

  it('contarNoLeidas cuenta filas del usuario en el evento', async () => {
    await sembrar({ userId: parejaId, minuto: 1 })
    await sembrar({ userId: parejaId, minuto: 2 })
    await sembrar({ userId: parejaId, minuto: 3, leida: true })
    await sembrar({ userId: plannerId, minuto: 4 })
    await sembrar({ userId: parejaId, eventId: otroEventId, minuto: 5 })

    expect(await repo.contarNoLeidas(eventId, parejaId)).toBe(2)
  })

  describe('marcarLeida', () => {
    it('marca la propia y un segundo marcado no cambia su readAt', async () => {
      const id = await sembrar({ userId: parejaId, minuto: 1 })
      const primera = new Date('2026-04-01T00:00:00.000Z')

      expect(await repo.marcarLeida(eventId, parejaId, id, primera)).toBe(true)
      expect(
        await repo.marcarLeida(eventId, parejaId, id, new Date('2026-05-01T00:00:00.000Z')),
      ).toBe(true)

      const fila = await prisma.notification.findUniqueOrThrow({ where: { id } })
      expect(fila.readAt).toEqual(primera)
    })

    it('la de OTRO usuario, o de otro evento, es "no existe" y no se toca', async () => {
      const ajena = await sembrar({ userId: plannerId, minuto: 1 })
      const deOtroEvento = await sembrar({ userId: parejaId, eventId: otroEventId, minuto: 2 })

      expect(await repo.marcarLeida(eventId, parejaId, ajena, new Date())).toBe(false)
      expect(await repo.marcarLeida(eventId, parejaId, deOtroEvento, new Date())).toBe(false)

      const filas = await prisma.notification.findMany({
        where: { id: { in: [ajena, deOtroEvento] } },
      })
      for (const fila of filas) expect(fila.readAt).toBeNull()
    })
  })

  it('destinatarios son los miembros ACTIVOS', async () => {
    expect((await repo.destinatarios(eventId)).sort()).toEqual([parejaId, plannerId].sort())
  })
})
