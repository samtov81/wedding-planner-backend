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

describe('UpdateEventVendorUseCase', () => {
  it('actualiza el status y el presupuesto asignado', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new UpdateEventVendorUseCase(vendors, categorias())
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
    const caso = new UpdateEventVendorUseCase(vendors, categorias())
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
    const caso = new UpdateEventVendorUseCase(vendors, categorias())

    await expect(
      caso.ejecutar(EVENTO, 'no-existe', { status: 'BOOKED' }, 'ana'),
    ).rejects.toBeInstanceOf(EventVendorNoEncontradoError)
  })

  it('rechaza actualizar un proveedor de OTRO evento: mismo 404 que uno inexistente', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new UpdateEventVendorUseCase(vendors, categorias())
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
    const caso = new UpdateEventVendorUseCase(vendors, categorias())
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
})
