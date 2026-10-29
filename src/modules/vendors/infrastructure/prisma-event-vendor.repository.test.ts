import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { PrismaEventVendorRepository } from './prisma-event-vendor.repository'

describe('PrismaEventVendorRepository.actualizar — contra Postgres', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let repo: PrismaEventVendorRepository
  let eventId: string
  let proveedorUserId: string
  let enlazadoId: string
  let externoId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    repo = new PrismaEventVendorRepository(prisma as unknown as PrismaService)
    const dueno = await prisma.user.create({
      data: { email: 'dueno@repo.test', passwordHash: 'x', fullName: 'Dueña' },
    })
    const proveedor = await prisma.user.create({
      data: { email: 'proveedor@repo.test', passwordHash: 'x', fullName: 'Proveedor' },
    })
    proveedorUserId = proveedor.id
    const categoryId = await categoriaId(prisma)
    const perfil = await prisma.vendorProfile.create({
      data: { userId: proveedor.id, businessName: 'Foto Sol', categoryId, status: 'PUBLISHED' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: dueno.id },
    })
    eventId = evento.id
    enlazadoId = (
      await prisma.eventVendor.create({
        data: { eventId, categoryId, vendorProfileId: perfil.id },
      })
    ).id
    externoId = (
      await prisma.eventVendor.create({ data: { eventId, categoryId, externalName: 'Pepa' } })
    ).id
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('dos PATCH a BOOKED seguidos: sólo el primero informa la transición', async () => {
    const primero = await repo.actualizar(
      eventId,
      enlazadoId,
      { status: 'BOOKED' },
      proveedorUserId,
    )
    const segundo = await repo.actualizar(
      eventId,
      enlazadoId,
      { status: 'BOOKED' },
      proveedorUserId,
    )

    expect(primero.contratado).toEqual({ proveedorUserId })
    expect(segundo.contratado).toBeNull()
    expect(segundo.vista.status).toBe('BOOKED')
  })

  it('cancelar y volver a BOOKED informa de nuevo la transición', async () => {
    const cancelado = await repo.actualizar(
      eventId,
      enlazadoId,
      { status: 'CANCELLED' },
      proveedorUserId,
    )
    const otraVez = await repo.actualizar(
      eventId,
      enlazadoId,
      { status: 'BOOKED' },
      proveedorUserId,
    )

    expect(cancelado.contratado).toBeNull()
    expect(otraVez.contratado).toEqual({ proveedorUserId })
  })

  it('una contratación externa informa la transición sin proveedor', async () => {
    const r = await repo.actualizar(eventId, externoId, { status: 'BOOKED' }, proveedorUserId)

    expect(r.contratado).toEqual({ proveedorUserId: null })
  })

  it('un cambio sin status no informa transición aunque ya esté BOOKED', async () => {
    const r = await repo.actualizar(eventId, enlazadoId, { specialty: 'Bodas' }, proveedorUserId)

    expect(r.contratado).toBeNull()
    expect(r.vista).toMatchObject({ status: 'BOOKED', specialty: 'Bodas' })
  })
})
