import { permisosDe } from './event-access'

describe('permisosDe', () => {
  it('el creador suma OWNER a su rol', () => {
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: true })).toEqual(['COUPLE', 'OWNER'])
  })

  it('un miembro que no creó el evento sólo tiene su rol', () => {
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: false })).toEqual(['COUPLE'])
    expect(permisosDe({ kind: 'member', role: 'PLANNER', owner: false })).toEqual(['PLANNER'])
  })

  it('un vendor contratado es VENDOR', () => {
    expect(permisosDe({ kind: 'vendor', eventVendorId: 'ev-v-1' })).toEqual(['VENDOR'])
  })

  it('admin y sin acceso no nombran ningún permiso: admin se resuelve antes en el guard', () => {
    expect(permisosDe({ kind: 'admin' })).toEqual([])
    expect(permisosDe({ kind: 'none' })).toEqual([])
  })
})
