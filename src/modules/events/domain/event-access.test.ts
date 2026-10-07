import { permisosDe } from './event-access'

describe('permisosDe', () => {
  it('el creador suma OWNER a su rol', () => {
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: true })).toEqual(
      expect.arrayContaining(['COUPLE', 'OWNER']),
    )
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

describe('permisosDe — presupuesto', () => {
  it('el creador lleva BUDGET_VIEW y BUDGET_EDIT además de su rol y OWNER', () => {
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: true })).toEqual([
      'COUPLE',
      'OWNER',
      'BUDGET_VIEW',
      'BUDGET_EDIT',
    ])
  })

  it('un miembro no creador y un vendor no llevan permisos de presupuesto', () => {
    expect(permisosDe({ kind: 'member', role: 'PLANNER', owner: false })).toEqual(['PLANNER'])
    expect(permisosDe({ kind: 'vendor', eventVendorId: 'x' })).toEqual(['VENDOR'])
  })
})
