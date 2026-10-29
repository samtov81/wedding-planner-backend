import { Logger } from '@nestjs/common'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import {
  categoriaSembrada,
  VendorCategoryRepositoryEnMemoria,
} from '../infrastructure/vendor-category.repository.fake'
import { CategoriasDeProveedor } from './categorias'
import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import { EventVendorRepositoryEnMemoria } from '../infrastructure/event-vendor.repository.fake'
import { UpdateEventVendorUseCase } from './update-event-vendor.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const categorias = () => new CategoriasDeProveedor(new VendorCategoryRepositoryEnMemoria())
const OTRO_EVENTO = '22222222-2222-4222-8222-222222222222'
const PERFIL = '33333333-3333-4333-8333-333333333333'
const PROVEEDOR = '44444444-4444-4444-8444-444444444444'

function armar(vendors: EventVendorRepositoryEnMemoria) {
  const notificaciones = new NotificationPortEnMemoria()
  const cola = new InMemoryQueueAdapter()
  const caso = new UpdateEventVendorUseCase(
    vendors,
    categorias(),
    notificaciones,
    new UnidadDeTrabajoEnMemoria(),
    cola,
  )
  return { caso, notificaciones, cola }
}

async function contratacion(
  vendors: EventVendorRepositoryEnMemoria,
  vendorRef: Parameters<EventVendorRepositoryEnMemoria['crear']>[0]['vendorRef'],
) {
  return await vendors.crear({
    eventId: EVENTO,
    vendorRef,
    category: categoriaSembrada('decor-floral'),
    specialty: null,
    assignedBudget: null,
    actorUserId: 'ana',
  })
}

function conPerfil(): EventVendorRepositoryEnMemoria {
  const vendors = new EventVendorRepositoryEnMemoria()
  vendors.perfiles.push({ id: PERFIL, status: 'PUBLISHED', userId: PROVEEDOR })
  return vendors
}

describe('UpdateEventVendorUseCase', () => {
  it('actualiza el status y el presupuesto asignado', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = armar(vendors).caso
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: categoriaSembrada('decor-floral'),
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    const actualizado = await caso.ejecutar(
      EVENTO,
      vista.id,
      { status: 'BOOKED', assignedBudget: '1500.00' },
      'ana',
    )

    expect(actualizado).toMatchObject({ status: 'BOOKED', assignedBudget: '1500.00' })
  })

  it('deja rastro en la auditoría de quién actualizó y qué campos cambiaron, sin datos personales', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = armar(vendors).caso
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: categoriaSembrada('decor-floral'),
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    await caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED', assignedBudget: '1500.00' }, 'ana')

    expect(vendors.auditoria).toContainEqual({
      actorUserId: 'ana',
      eventId: EVENTO,
      action: 'event_vendor.updated',
      target: `event_vendor:${vista.id}`,
    })
  })

  it('rechaza actualizar un id que no existe', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = armar(vendors).caso

    await expect(
      caso.ejecutar(EVENTO, 'no-existe', { status: 'BOOKED' }, 'ana'),
    ).rejects.toBeInstanceOf(EventVendorNoEncontradoError)
  })

  it('rechaza actualizar un proveedor de OTRO evento: mismo 404 que uno inexistente', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = armar(vendors).caso
    const vista = await vendors.crear({
      eventId: OTRO_EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: categoriaSembrada('decor-floral'),
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    await expect(
      caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED' }, 'ana'),
    ).rejects.toBeInstanceOf(EventVendorNoEncontradoError)
  })

  it('cambia la categoría por su slug y rechaza una que no existe', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = armar(vendors).caso
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'DJ Max', email: null, phone: null },
      category: categoriaSembrada('catering'),
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    const cambiado = await caso.ejecutar(
      EVENTO,
      vista.id,
      { category: 'music-entertainment' },
      'ana',
    )
    expect(cambiado.category).toEqual({
      slug: 'music-entertainment',
      name: 'Music & Entertainment',
    })

    await expect(caso.ejecutar(EVENTO, vista.id, { category: 'dj' }, 'ana')).rejects.toMatchObject({
      code: 'VENDOR_CATEGORY_UNKNOWN',
    })
  })

  describe('aviso al proveedor contratado', () => {
    const enlazado = { kind: 'linked', vendorProfileId: PERFIL } as const

    it('pasar a BOOKED avisa al proveedor de la contratación', async () => {
      const vendors = conPerfil()
      const { caso, notificaciones, cola } = armar(vendors)
      const vista = await contratacion(vendors, enlazado)

      await caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED' }, 'ana')

      expect(notificaciones.creadas).toEqual([
        {
          eventId: EVENTO,
          userId: PROVEEDOR,
          tipo: 'event.vendor.booked',
          payload: { eventVendorId: vista.id },
        },
      ])
      expect(cola.encolados).toHaveLength(1)
      expect(cola.encolados[0]).toMatchObject({
        cola: 'notifications',
        nombre: 'event.vendor.booked',
        datos: { eventId: EVENTO, userId: PROVEEDOR },
      })
    })

    it('BOOKED → BOOKED no vuelve a avisar', async () => {
      const vendors = conPerfil()
      const { caso, notificaciones, cola } = armar(vendors)
      const vista = await contratacion(vendors, enlazado)
      await caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED' }, 'ana')

      await caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED' }, 'ana')

      expect(notificaciones.creadas).toHaveLength(1)
      expect(cola.encolados).toHaveLength(1)
    })

    it('un PATCH sin status no avisa', async () => {
      const vendors = conPerfil()
      const { caso, notificaciones, cola } = armar(vendors)
      const vista = await contratacion(vendors, enlazado)

      await caso.ejecutar(EVENTO, vista.id, { assignedBudget: '10.00' }, 'ana')

      expect(notificaciones.creadas).toEqual([])
      expect(cola.encolados).toEqual([])
    })

    it('una contratación externa pasa a BOOKED sin avisar a nadie', async () => {
      const vendors = conPerfil()
      const { caso, notificaciones, cola } = armar(vendors)
      const vista = await contratacion(vendors, {
        kind: 'external',
        name: 'Flores Pepa',
        email: null,
        phone: null,
      })

      const r = await caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED' }, 'ana')

      expect(r.status).toBe('BOOKED')
      expect(notificaciones.creadas).toEqual([])
      expect(cola.encolados).toEqual([])
    })

    it('si avisar falla, el PATCH falla y no se encola nada', async () => {
      const vendors = conPerfil()
      const { caso, notificaciones, cola } = armar(vendors)
      const vista = await contratacion(vendors, enlazado)
      notificaciones.fallarProximaCreacion(new Error('base de datos caída'))

      await expect(caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED' }, 'ana')).rejects.toThrow(
        'base de datos caída',
      )

      expect(cola.encolados).toEqual([])
    })

    it('si encolar falla, el PATCH responde igual', async () => {
      const vendors = conPerfil()
      const { notificaciones } = armar(vendors)
      const vista = await contratacion(vendors, enlazado)
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const cola = new InMemoryQueueAdapter()
      vi.spyOn(cola, 'enqueue').mockRejectedValue(new Error('redis caído'))
      const casoConCola = new UpdateEventVendorUseCase(
        vendors,
        categorias(),
        notificaciones,
        new UnidadDeTrabajoEnMemoria(),
        cola,
      )

      const r = await casoConCola.ejecutar(EVENTO, vista.id, { status: 'BOOKED' }, 'ana')

      expect(r.status).toBe('BOOKED')
      expect(notificaciones.creadas).toHaveLength(1)
    })
  })
})
