import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { CategoriasDeProveedor } from '../application/categorias'
import { UpdateEventVendorUseCase } from '../application/update-event-vendor.use-case'
import { PrismaEventVendorRepository } from './prisma-event-vendor.repository'
import { VendorCategoryRepositoryEnMemoria } from './vendor-category.repository.fake'

/**
 * `UnidadDeTrabajoEnMemoria` no deshace nada: con los dobles un `actualizar`
 * sacado de la transacción dejaría la contratación en BOOKED y el test en
 * verde. Aquí la unidad de trabajo y el repositorio son los reales, contra
 * Postgres: lo que se prueba es que `actualizar` se UNE a la transacción del
 * caso de uso (`enTransaccion`) en vez de abrir la suya.
 */
describe('Contratar a un proveedor — atomicidad contra Postgres', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let eventId: string
  let eventVendorId: string
  let duenoId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const dueno = await prisma.user.create({
      data: { email: 'dueno@atomicidad.test', passwordHash: 'x', fullName: 'Dueña' },
    })
    duenoId = dueno.id
    const proveedor = await prisma.user.create({
      data: { email: 'proveedor@atomicidad.test', passwordHash: 'x', fullName: 'Proveedor' },
    })
    const categoryId = await categoriaId(prisma)
    const perfil = await prisma.vendorProfile.create({
      data: { userId: proveedor.id, businessName: 'Foto Sol', categoryId, status: 'PUBLISHED' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: dueno.id },
    })
    eventId = evento.id
    eventVendorId = (
      await prisma.eventVendor.create({
        data: { eventId, categoryId, vendorProfileId: perfil.id },
      })
    ).id
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('si crear el aviso falla, la contratación sigue en SHORTLISTED', async () => {
    const servicio = prisma as unknown as PrismaService
    const notificaciones = new NotificationPortEnMemoria()
    notificaciones.fallarProximaCreacion(new Error('base de datos caída'))
    const cola = new InMemoryQueueAdapter()
    const caso = new UpdateEventVendorUseCase(
      new PrismaEventVendorRepository(servicio),
      new CategoriasDeProveedor(new VendorCategoryRepositoryEnMemoria()),
      notificaciones,
      new PrismaUnidadDeTrabajo(servicio),
      cola,
    )

    await expect(
      caso.ejecutar(eventId, eventVendorId, { status: 'BOOKED' }, duenoId),
    ).rejects.toThrow('base de datos caída')

    const fila = await prisma.eventVendor.findUniqueOrThrow({ where: { id: eventVendorId } })
    expect(fila.status).toBe('SHORTLISTED')
    expect(await prisma.auditLog.count({ where: { action: 'event_vendor.updated' } })).toBe(0)
    expect(notificaciones.creadas).toEqual([])
    expect(cola.encolados).toEqual([])
  })
})
