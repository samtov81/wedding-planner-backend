import { EventVendorNoEncontradoError, ProveedorConGastosError } from '../domain/vendor-errors'
import { EventVendorRepositoryEnMemoria } from '../infrastructure/event-vendor.repository.fake'
import { RemoveEventVendorUseCase } from './remove-event-vendor.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO_EVENTO = '22222222-2222-4222-8222-222222222222'

describe('RemoveEventVendorUseCase', () => {
  it('elimina el proveedor del evento', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new RemoveEventVendorUseCase(vendors)
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    await caso.ejecutar(EVENTO, vista.id, 'ana')

    expect(await vendors.buscarPorId(EVENTO, vista.id)).toBeNull()
  })

  it('deja rastro en la auditoría de quién eliminó, sin datos personales', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new RemoveEventVendorUseCase(vendors)
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    await caso.ejecutar(EVENTO, vista.id, 'ana')

    expect(vendors.auditoria).toContainEqual({
      actorUserId: 'ana',
      eventId: EVENTO,
      action: 'event_vendor.removed',
      target: `event_vendor:${vista.id}`,
    })
  })

  it('rechaza eliminar un id que no existe', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new RemoveEventVendorUseCase(vendors)

    await expect(caso.ejecutar(EVENTO, 'no-existe', 'ana')).rejects.toBeInstanceOf(
      EventVendorNoEncontradoError,
    )
  })

  it('rechaza eliminar un proveedor de OTRO evento', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new RemoveEventVendorUseCase(vendors)
    const vista = await vendors.crear({
      eventId: OTRO_EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    await expect(caso.ejecutar(EVENTO, vista.id, 'ana')).rejects.toBeInstanceOf(
      EventVendorNoEncontradoError,
    )
  })

  it('rechaza eliminar un proveedor con gastos registrados (409)', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new RemoveEventVendorUseCase(vendors)
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: '1500.00',
      actorUserId: 'ana',
    })
    vendors.gastos.push({ eventId: EVENTO, eventVendorId: vista.id })

    await expect(caso.ejecutar(EVENTO, vista.id, 'ana')).rejects.toBeInstanceOf(
      ProveedorConGastosError,
    )
    expect(await vendors.buscarPorId(EVENTO, vista.id)).not.toBeNull()
  })
})
