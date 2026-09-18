import { UnprocessableError } from '@/shared/domain'

import { EventVendorRepositoryEnMemoria } from '../infrastructure/event-vendor.repository.fake'
import { VendorProfileNoDisponibleError } from '../domain/vendor-errors'
import { AddEventVendorUseCase } from './add-event-vendor.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const ANA = 'ana-id'

describe('AddEventVendorUseCase', () => {
  let vendors: EventVendorRepositoryEnMemoria
  let caso: AddEventVendorUseCase

  beforeEach(() => {
    vendors = new EventVendorRepositoryEnMemoria()
    caso = new AddEventVendorUseCase(vendors)
  })

  it('contrata a un proveedor externo sin cuenta en el marketplace', async () => {
    const vista = await caso.ejecutar(EVENTO, {
      externalName: 'Flores Pepa',
      externalEmail: 'pepa@flores.es',
      category: 'Floristería',
      actorUserId: ANA,
    })

    expect(vista).toMatchObject({
      eventId: EVENTO,
      vendorRef: { kind: 'external', name: 'Flores Pepa', email: 'pepa@flores.es', phone: null },
      category: 'Floristería',
      status: 'SHORTLISTED',
    })
  })

  it('enlaza una ficha del marketplace que está PUBLISHED', async () => {
    vendors.perfiles.push({ id: 'perfil-1', status: 'PUBLISHED' })

    const vista = await caso.ejecutar(EVENTO, {
      vendorProfileId: 'perfil-1',
      category: 'Catering',
      actorUserId: ANA,
    })

    expect(vista.vendorRef).toEqual({ kind: 'linked', vendorProfileId: 'perfil-1' })
  })

  it('rechaza enlazar una ficha en DRAFT: no se ofrece todavía', async () => {
    vendors.perfiles.push({ id: 'perfil-1', status: 'DRAFT' })

    await expect(
      caso.ejecutar(EVENTO, {
        vendorProfileId: 'perfil-1',
        category: 'Catering',
        actorUserId: ANA,
      }),
    ).rejects.toBeInstanceOf(VendorProfileNoDisponibleError)
  })

  it('rechaza enlazar una ficha SUSPENDED: se retiró', async () => {
    vendors.perfiles.push({ id: 'perfil-1', status: 'SUSPENDED' })

    await expect(
      caso.ejecutar(EVENTO, {
        vendorProfileId: 'perfil-1',
        category: 'Catering',
        actorUserId: ANA,
      }),
    ).rejects.toBeInstanceOf(VendorProfileNoDisponibleError)
  })

  it('rechaza una ficha inexistente igual que una no publicada', async () => {
    await expect(
      caso.ejecutar(EVENTO, {
        vendorProfileId: 'no-existe',
        category: 'Catering',
        actorUserId: ANA,
      }),
    ).rejects.toBeInstanceOf(VendorProfileNoDisponibleError)
  })

  it('rechaza traer ficha del marketplace y datos externos a la vez', async () => {
    vendors.perfiles.push({ id: 'perfil-1', status: 'PUBLISHED' })

    await expect(
      caso.ejecutar(EVENTO, {
        vendorProfileId: 'perfil-1',
        externalName: 'Flores Pepa',
        category: 'Catering',
        actorUserId: ANA,
      }),
    ).rejects.toBeInstanceOf(UnprocessableError)
  })

  it('rechaza no traer ni ficha ni datos externos', async () => {
    await expect(
      caso.ejecutar(EVENTO, { category: 'Catering', actorUserId: ANA }),
    ).rejects.toBeInstanceOf(UnprocessableError)
  })

  it('deja rastro en la auditoría de quién dio de alta al proveedor', async () => {
    const vista = await caso.ejecutar(EVENTO, {
      externalName: 'Flores Pepa',
      category: 'Floristería',
      actorUserId: ANA,
    })

    expect(vendors.auditoria).toEqual([
      {
        actorUserId: ANA,
        eventId: EVENTO,
        action: 'event_vendor.added',
        target: `event_vendor:${vista.id}`,
      },
    ])
  })

  it('no consulta el marketplace para un proveedor externo', async () => {
    const espia = vi.spyOn(vendors, 'buscarPerfilPublicado')

    await caso.ejecutar(EVENTO, {
      externalName: 'Flores Pepa',
      category: 'Floristería',
      actorUserId: ANA,
    })

    expect(espia).not.toHaveBeenCalled()
  })
})
