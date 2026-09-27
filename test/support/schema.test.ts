import { PrismaClient } from '@prisma/client'

import { categoriaId } from './categorias'
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
      data: {
        userId: perfilUser.id,
        businessName: 'Lumière',
        categoryId: await categoriaId(prisma, 'catering'),
      },
    })

    await expect(
      prisma.eventVendor.create({
        data: {
          eventId,
          vendorProfileId: perfil.id,
          externalName: 'También externo',
          categoryId: await categoriaId(prisma, 'catering'),
        },
      }),
    ).rejects.toThrow(/event_vendors_origen_exclusivo/)
  })

  it('rechaza un EventVendor sin ninguno de los dos orígenes', async () => {
    await expect(
      prisma.eventVendor.create({
        data: { eventId, categoryId: await categoriaId(prisma, 'decor-floral') },
      }),
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

  it('rechaza borrar una VendorProfile que tiene un EventVendor asociado', async () => {
    const perfilUser = await prisma.user.create({
      data: { email: 'con-historial@test.com', passwordHash: 'x', fullName: 'Con Historial' },
    })
    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: perfilUser.id,
        businessName: 'Con Historial SL',
        categoryId: await categoriaId(prisma, 'photography'),
      },
    })
    await prisma.eventVendor.create({
      data: {
        eventId,
        vendorProfileId: perfil.id,
        categoryId: await categoriaId(prisma, 'photography'),
      },
    })

    await expect(prisma.vendorProfile.delete({ where: { id: perfil.id } })).rejects.toThrow(
      /event_vendors_vendorProfileId_fkey/,
    )
  })

  it('permite borrar una VendorProfile sin ningún EventVendor asociado', async () => {
    const perfilUser = await prisma.user.create({
      data: { email: 'sin-historial@test.com', passwordHash: 'x', fullName: 'Sin Historial' },
    })
    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: perfilUser.id,
        businessName: 'Sin Historial SL',
        categoryId: await categoriaId(prisma, 'music-entertainment'),
      },
    })

    await expect(prisma.vendorProfile.delete({ where: { id: perfil.id } })).resolves.toMatchObject({
      id: perfil.id,
    })
  })

  describe('eventos, cronograma y gastos', () => {
    let ownerId: string

    beforeAll(async () => {
      const owner = await prisma.user.findFirstOrThrow({ where: { email: 'owner@test.com' } })
      ownerId = owner.id
    })

    it('un evento nuevo nace en DRAFT y admite no tener fecha', async () => {
      const evento = await prisma.event.create({ data: { name: 'Borrador', ownerId } })
      expect(evento.status).toBe('DRAFT')
      expect(evento.weddingDate).toBeNull()
      expect(evento.currency).toBe('USD')
    })

    it('rechaza un evento ACTIVE sin fecha', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, status: 'ACTIVE' } }),
      ).rejects.toThrow(/events_activo_con_fecha/)
    })

    it('rechaza latitud sin longitud en el venue', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, venueLat: 4.6 } }),
      ).rejects.toThrow(/events_venue_coords/)
    })

    it('rechaza una latitud fuera de rango', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, venueLat: 91, venueLng: 0 } }),
      ).rejects.toThrow(/events_venue_coords/)
    })

    it('rechaza un presupuesto total negativo', async () => {
      await expect(
        prisma.event.create({ data: { name: 'X', ownerId, totalBudget: -1 } }),
      ).rejects.toThrow(/events_total_budget_no_negativo/)
    })

    it('rechaza un ítem de cronograma que acaba antes de empezar', async () => {
      await expect(
        prisma.scheduleItem.create({
          data: {
            eventId,
            title: 'Fiesta',
            startsAt: new Date('2027-06-12T20:00:00Z'),
            endsAt: new Date('2027-06-12T19:00:00Z'),
          },
        }),
      ).rejects.toThrow(/schedule_items_rango/)
    })

    it('rechaza un gasto con proveedor Y beneficiario externo', async () => {
      const vendor = await prisma.eventVendor.create({
        data: {
          eventId,
          externalName: 'DJ',
          categoryId: await categoriaId(prisma, 'music-entertainment'),
        },
      })
      await expect(
        prisma.expense.create({
          data: {
            eventId,
            eventVendorId: vendor.id,
            payeeName: 'Otro',
            concept: 'Anticipo',
            category: 'Music',
            amount: 100,
            createdById: ownerId,
          },
        }),
      ).rejects.toThrow(/expenses_origen_exclusivo/)
    })

    it('rechaza un gasto sin ningún origen', async () => {
      await expect(
        prisma.expense.create({
          data: { eventId, concept: 'X', category: 'X', amount: 100, createdById: ownerId },
        }),
      ).rejects.toThrow(/expenses_origen_exclusivo/)
    })

    it('rechaza un gasto de monto cero', async () => {
      await expect(
        prisma.expense.create({
          data: {
            eventId,
            payeeName: 'Imprenta',
            concept: 'X',
            category: 'X',
            amount: 0,
            createdById: ownerId,
          },
        }),
      ).rejects.toThrow(/expenses_monto_positivo/)
    })

    it('rechaza un gasto PAID sin fecha de pago', async () => {
      await expect(
        prisma.expense.create({
          data: {
            eventId,
            payeeName: 'Imprenta',
            concept: 'X',
            category: 'X',
            amount: 10,
            status: 'PAID',
            createdById: ownerId,
          },
        }),
      ).rejects.toThrow(/expenses_pagado_con_fecha/)
    })

    it('impide borrar un EventVendor que tiene gastos', async () => {
      const vendor = await prisma.eventVendor.create({
        data: {
          eventId,
          externalName: 'Flores',
          categoryId: await categoriaId(prisma, 'decor-floral'),
        },
      })
      await prisma.expense.create({
        data: {
          eventId,
          eventVendorId: vendor.id,
          concept: 'Anticipo',
          category: 'Floral',
          amount: 50,
          createdById: ownerId,
        },
      })
      await expect(prisma.eventVendor.delete({ where: { id: vendor.id } })).rejects.toThrow()
    })
  })
  describe('distribución de mesas', () => {
    const mesa = { name: 'Mesa 1', minSeats: 2, maxSeats: 4, seatCount: 2 }

    it('rechaza asientos fuera de mínimo..máximo o un máximo de más de 20', async () => {
      await expect(
        prisma.seatingTable.create({ data: { eventId, ...mesa, seatCount: 5 } }),
      ).rejects.toThrow(/seating_tables_asientos_rango/)
      await expect(
        prisma.seatingTable.create({ data: { eventId, ...mesa, seatCount: 1 } }),
      ).rejects.toThrow(/seating_tables_asientos_rango/)
      await expect(
        prisma.seatingTable.create({
          data: { eventId, ...mesa, seatCount: 21, maxSeats: 21 },
        }),
      ).rejects.toThrow(/seating_tables_asientos_rango/)
    })

    it('rechaza una posición negativa', async () => {
      await expect(
        prisma.seatingTable.create({ data: { eventId, ...mesa, x: -1 } }),
      ).rejects.toThrow(/seating_tables_posicion/)
    })

    it('rechaza índices negativos o un acompañante 11', async () => {
      const t = await prisma.seatingTable.create({ data: { eventId, ...mesa } })
      const g = await prisma.guest.create({ data: { eventId, name: 'Sentado', group: 'Family' } })
      await expect(
        prisma.seatAssignment.create({
          data: { eventId, tableId: t.id, seatIndex: -1, guestId: g.id, companionIndex: 0 },
        }),
      ).rejects.toThrow(/seat_assignments_indices/)
      await expect(
        prisma.seatAssignment.create({
          data: { eventId, tableId: t.id, seatIndex: 0, guestId: g.id, companionIndex: 11 },
        }),
      ).rejects.toThrow(/seat_assignments_indices/)
    })

    it('borrar al invitado libera su asiento', async () => {
      const t = await prisma.seatingTable.create({ data: { eventId, ...mesa } })
      const g = await prisma.guest.create({ data: { eventId, name: 'Se va', group: 'Family' } })
      await prisma.seatAssignment.create({
        data: { eventId, tableId: t.id, seatIndex: 0, guestId: g.id, companionIndex: 0 },
      })
      await prisma.guest.delete({ where: { id: g.id } })
      expect(await prisma.seatAssignment.count({ where: { tableId: t.id } })).toBe(0)
    })
  })
})
