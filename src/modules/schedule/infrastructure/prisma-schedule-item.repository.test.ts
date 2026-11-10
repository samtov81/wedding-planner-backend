import { Prisma, PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { PrismaScheduleItemRepository } from './prisma-schedule-item.repository'

/**
 * Lo que sólo Postgres puede probar de las asignaciones: el UNIQUE
 * `(scheduleItemId, eventVendorId)` y las dos cascadas (spec 2026-11-10 §9).
 * El comportamiento del puerto se compara con el doble en la paridad.
 */
describe('PrismaScheduleItemRepository (Postgres real)', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let repo: PrismaScheduleItemRepository
  let plannerId: string
  let eventId: string
  let categoryId: string
  let vendorProfileId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    repo = new PrismaScheduleItemRepository(prisma as unknown as PrismaService)
    plannerId = (
      await prisma.user.create({
        data: { email: 'planner@int-schedule.test', passwordHash: 'x', fullName: 'Planner' },
      })
    ).id
    eventId = (await prisma.event.create({ data: { name: 'Boda', ownerId: plannerId } })).id
    categoryId = (
      await prisma.vendorCategory.create({
        data: { slug: 'int-schedule', name: 'Int Schedule', position: 1 },
      })
    ).id
    const proveedor = await prisma.user.create({
      data: { email: 'prov@int-schedule.test', passwordHash: 'x', fullName: 'Prov' },
    })
    vendorProfileId = (
      await prisma.vendorProfile.create({
        data: { userId: proveedor.id, businessName: 'Prov', categoryId },
      })
    ).id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  /** Un ítem y una contratación BOOKED, con una asignación entre ambos. */
  async function asignado() {
    const item = await repo.crear({
      eventId,
      title: 'Ceremonia',
      description: null,
      startsAt: new Date('2027-06-12T18:00:00Z'),
      endsAt: null,
      location: null,
      status: 'PENDING',
    })
    const contratacion = await prisma.eventVendor.create({
      data: { eventId, categoryId, vendorProfileId, status: 'BOOKED' },
    })
    await repo.fijarAsignaciones(item.id, [contratacion.id], plannerId)
    return { itemId: item.id, eventVendorId: contratacion.id }
  }

  const filas = (where: Prisma.ScheduleItemVendorWhereInput) =>
    prisma.scheduleItemVendor.count({ where })

  it('una segunda fila (ítem, contratación) choca con el UNIQUE (P2002)', async () => {
    const { itemId, eventVendorId } = await asignado()

    const error: unknown = await prisma.scheduleItemVendor
      .create({ data: { scheduleItemId: itemId, eventVendorId, assignedById: plannerId } })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')
  })

  it('borrar el ítem borra sus asignaciones', async () => {
    const { itemId, eventVendorId } = await asignado()
    expect(await filas({ scheduleItemId: itemId })).toBe(1)

    expect(await repo.eliminar(eventId, itemId)).toBe(true)

    expect(await filas({ scheduleItemId: itemId })).toBe(0)
    expect(await prisma.eventVendor.count({ where: { id: eventVendorId } })).toBe(1)
  })

  it('borrar la contratación borra sus asignaciones', async () => {
    const { itemId, eventVendorId } = await asignado()
    expect(await filas({ eventVendorId })).toBe(1)

    await prisma.eventVendor.delete({ where: { id: eventVendorId } })

    expect(await filas({ eventVendorId })).toBe(0)
    expect(await prisma.scheduleItem.count({ where: { id: itemId } })).toBe(1)
  })
})
