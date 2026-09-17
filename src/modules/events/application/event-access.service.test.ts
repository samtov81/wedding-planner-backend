import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { EventAccessService } from './event-access.service'

describe('EventAccessService', () => {
  let repo: EventRepositoryEnMemoria
  let servicio: EventAccessService

  beforeEach(() => {
    repo = new EventRepositoryEnMemoria()
    repo.eventos.push({ id: 'ev-1', ownerId: 'user-pareja' })
    servicio = new EventAccessService(repo)
  })

  it('resuelve COUPLE para un miembro activo con ese rol', async () => {
    repo.membresias.push({
      eventId: 'ev-1',
      userId: 'user-pareja',
      role: 'COUPLE',
      status: 'ACTIVE',
    })

    expect(await servicio.resolve('user-pareja', 'USER', 'ev-1')).toEqual({
      kind: 'member',
      role: 'COUPLE',
    })
  })

  it('resuelve PLANNER, y el mismo usuario puede ser COUPLE en otro evento', async () => {
    repo.eventos.push({ id: 'ev-2', ownerId: 'user-planner' })
    repo.membresias.push({
      eventId: 'ev-1',
      userId: 'user-planner',
      role: 'PLANNER',
      status: 'ACTIVE',
    })
    repo.membresias.push({
      eventId: 'ev-2',
      userId: 'user-planner',
      role: 'COUPLE',
      status: 'ACTIVE',
    })

    expect(await servicio.resolve('user-planner', 'USER', 'ev-1')).toEqual({
      kind: 'member',
      role: 'PLANNER',
    })
    expect(await servicio.resolve('user-planner', 'USER', 'ev-2')).toEqual({
      kind: 'member',
      role: 'COUPLE',
    })
  })

  it('una membresía REVOKED no da acceso', async () => {
    repo.membresias.push({ eventId: 'ev-1', userId: 'ex', role: 'PLANNER', status: 'REVOKED' })

    expect(await servicio.resolve('ex', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('una membresía INVITED tampoco: invitar no es aceptar', async () => {
    repo.membresias.push({
      eventId: 'ev-1',
      userId: 'pendiente',
      role: 'PLANNER',
      status: 'INVITED',
    })

    expect(await servicio.resolve('pendiente', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('resuelve vendor sólo cuando la contratación está BOOKED', async () => {
    repo.perfiles.push({ id: 'perfil-1', userId: 'user-vendor' })
    repo.eventVendors.push({
      id: 'ev-v-1',
      eventId: 'ev-1',
      vendorProfileId: 'perfil-1',
      status: 'BOOKED',
    })

    expect(await servicio.resolve('user-vendor', 'USER', 'ev-1')).toEqual({
      kind: 'vendor',
      eventVendorId: 'ev-v-1',
    })
  })

  it('un vendor sólo SHORTLISTED no tiene acceso', async () => {
    repo.perfiles.push({ id: 'perfil-2', userId: 'user-candidato' })
    repo.eventVendors.push({
      id: 'ev-v-2',
      eventId: 'ev-1',
      vendorProfileId: 'perfil-2',
      status: 'SHORTLISTED',
    })

    expect(await servicio.resolve('user-candidato', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('un vendor externo no da acceso a nadie: no hay cuenta detrás', async () => {
    repo.eventVendors.push({
      id: 'ev-v-3',
      eventId: 'ev-1',
      vendorProfileId: null,
      status: 'BOOKED',
    })

    expect(await servicio.resolve('cualquiera', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })

  it('un ADMIN accede a cualquier evento sin membresía', async () => {
    expect(await servicio.resolve('root', 'ADMIN', 'ev-1')).toEqual({ kind: 'admin' })
  })

  it('un desconocido no obtiene acceso', async () => {
    expect(await servicio.resolve('nadie', 'USER', 'ev-1')).toEqual({ kind: 'none' })
  })
})
