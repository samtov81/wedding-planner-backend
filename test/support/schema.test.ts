import { PrismaClient } from '@prisma/client'

import { startPostgres, type PostgresDeTest } from './containers'

describe('restricciones del esquema', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let eventId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const owner = await prisma.user.create({
      data: { email: 'owner@test.com', passwordHash: 'x', fullName: 'Owner' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: owner.id },
    })
    eventId = evento.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  it('rechaza un EventVendor que sea a la vez de marketplace y externo', async () => {
    const perfilUser = await prisma.user.create({
      data: { email: 'vendor@test.com', passwordHash: 'x', fullName: 'Vendor' },
    })
    const perfil = await prisma.vendorProfile.create({
      data: { userId: perfilUser.id, businessName: 'Lumière', category: 'Catering' },
    })

    await expect(
      prisma.eventVendor.create({
        data: {
          eventId,
          vendorProfileId: perfil.id,
          externalName: 'También externo',
          category: 'Catering',
        },
      }),
    ).rejects.toThrow(/event_vendors_origen_exclusivo/)
  })

  it('rechaza un EventVendor sin ninguno de los dos orígenes', async () => {
    await expect(
      prisma.eventVendor.create({ data: { eventId, category: 'Flores' } }),
    ).rejects.toThrow(/event_vendors_origen_exclusivo/)
  })

  it('admite varios invitados sin email en el mismo evento', async () => {
    await prisma.guest.create({ data: { eventId, name: 'Tía Carmen', group: 'Family' } })
    await prisma.guest.create({ data: { eventId, name: 'Tío Paco', group: 'Family' } })

    const sinEmail = await prisma.guest.count({ where: { eventId, email: null } })
    expect(sinEmail).toBe(2)
  })

  it('impide dos invitados con el mismo email en el mismo evento', async () => {
    await prisma.guest.create({
      data: { eventId, name: 'Ana', email: 'ana@test.com', group: 'Work' },
    })

    // DESIGN-GAP: el brief original espera que el mensaje cite el nombre del
    // índice (`guests_event_email_unico`). En la práctica, Prisma sólo lo
    // hace para errores que la base de datos deja pasar en crudo (como el
    // CHECK de arriba); para un P2002 sobre un índice único que no declaró
    // el propio Prisma (el parcial se añadió a mano en la migración),
    // reporta las columnas (`eventId`, `email`), no el nombre del índice.
    // Se comprueba código y columnas en vez del nombre literal: sigue
    // demostrando que el índice parcial es lo que produce el rechazo.
    await expect(
      prisma.guest.create({
        data: { eventId, name: 'Ana bis', email: 'ana@test.com', group: 'Work' },
      }),
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['eventId', 'email'] } })
  })
})
