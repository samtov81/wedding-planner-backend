import { EventVendorRepositoryEnMemoria } from '../infrastructure/event-vendor.repository.fake'
import { ListEventVendorsUseCase } from './list-event-vendors.use-case'

const EVENTO_A = '11111111-1111-4111-8111-111111111111'
const EVENTO_B = '22222222-2222-4222-8222-222222222222'

describe('ListEventVendorsUseCase', () => {
  it('sólo lista los proveedores del evento pedido', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new ListEventVendorsUseCase(vendors)

    await vendors.crear({
      eventId: EVENTO_A,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: null, phone: null },
      category: 'Floristería',
      specialty: null,
      assignedBudget: null,
      actorUserId: 'ana',
    })
    await vendors.crear({
      eventId: EVENTO_B,
      vendorRef: { kind: 'external', name: 'Catering Ruta', email: null, phone: null },
      category: 'Catering',
      specialty: null,
      assignedBudget: null,
      actorUserId: 'pedro',
    })

    const resultado = await caso.ejecutar(EVENTO_A)

    expect(resultado).toHaveLength(1)
    expect(resultado[0]).toMatchObject({ eventId: EVENTO_A, category: 'Floristería' })
  })

  it('un evento sin proveedores devuelve una lista vacía', async () => {
    const vendors = new EventVendorRepositoryEnMemoria()
    const caso = new ListEventVendorsUseCase(vendors)

    await expect(caso.ejecutar(EVENTO_A)).resolves.toEqual([])
  })
})
