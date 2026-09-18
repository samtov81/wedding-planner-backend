import { EventVendorNoEncontradoError } from '../domain/vendor-errors'
import { EventVendorRepositoryEnMemoria } from '../infrastructure/event-vendor.repository.fake'
import { UpdateEventVendorUseCase } from './update-event-vendor.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const OTRO_EVENTO = '22222222-2222-4222-8222-222222222222'

describe('UpdateEventVendorUseCase', () => {
  it('actualiza el status y el presupuesto asignado', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new UpdateEventVendorUseCase(vendors)
    const vista = await vendors.crear({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    const actualizado = await caso.ejecutar(EVENTO, vista.id, {
      status: 'BOOKED',
      assignedBudget: 1500,
    })

    expect(actualizado).toMatchObject({ status: 'BOOKED', assignedBudget: 1500 })
  })

  it('rechaza actualizar un id que no existe', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new UpdateEventVendorUseCase(vendors)

    await expect(caso.ejecutar(EVENTO, 'no-existe', { status: 'BOOKED' })).rejects.toBeInstanceOf(
      EventVendorNoEncontradoError,
    )
  })

  it('rechaza actualizar un proveedor de OTRO evento: mismo 404 que uno inexistente', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new UpdateEventVendorUseCase(vendors)
    const vista = await vendors.crear({
      eventId: OTRO_EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })

    await expect(caso.ejecutar(EVENTO, vista.id, { status: 'BOOKED' })).rejects.toBeInstanceOf(
      EventVendorNoEncontradoError,
    )
  })
})
