import { esPlannerDelEvento, permisosDe, puedeCambiarEstadoDelCronograma } from './event-access'

describe('esPlannerDelEvento', () => {
  it('lo son el admin y el PLANNER, sea o no el creador', () => {
    expect(esPlannerDelEvento({ kind: 'admin' })).toBe(true)
    for (const owner of [true, false]) {
      expect(
        esPlannerDelEvento({ kind: 'member', role: 'PLANNER', owner, budgetView: false }),
      ).toBe(true)
    }
  })

  it('no lo son la pareja, el proveedor ni quien no tiene acceso', () => {
    expect(
      esPlannerDelEvento({ kind: 'member', role: 'COUPLE', owner: true, budgetView: true }),
    ).toBe(false)
    expect(esPlannerDelEvento({ kind: 'vendor', eventVendorId: 'x' })).toBe(false)
    expect(esPlannerDelEvento({ kind: 'none' })).toBe(false)
  })
})

describe('puedeCambiarEstadoDelCronograma', () => {
  it('lo cambian el PLANNER (creador o invitado) y el admin', () => {
    expect(
      puedeCambiarEstadoDelCronograma({
        kind: 'member',
        role: 'PLANNER',
        owner: true,
        budgetView: false,
      }),
    ).toBe(true)
    expect(
      puedeCambiarEstadoDelCronograma({
        kind: 'member',
        role: 'PLANNER',
        owner: false,
        budgetView: false,
      }),
    ).toBe(true)
    expect(puedeCambiarEstadoDelCronograma({ kind: 'admin' })).toBe(true)
  })

  it('no lo cambia un COUPLE, aunque sea el creador de un evento antiguo', () => {
    expect(
      puedeCambiarEstadoDelCronograma({
        kind: 'member',
        role: 'COUPLE',
        owner: true,
        budgetView: true,
      }),
    ).toBe(false)
    expect(puedeCambiarEstadoDelCronograma({ kind: 'vendor', eventVendorId: 'x' })).toBe(false)
    expect(puedeCambiarEstadoDelCronograma({ kind: 'none' })).toBe(false)
  })
})

describe('permisosDe', () => {
  it('el creador suma OWNER a su rol', () => {
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: true, budgetView: false })).toEqual(
      expect.arrayContaining(['COUPLE', 'OWNER']),
    )
  })

  it('un miembro que no creó el evento sólo tiene su rol', () => {
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: false, budgetView: false })).toEqual(
      ['COUPLE'],
    )
    expect(
      permisosDe({ kind: 'member', role: 'PLANNER', owner: false, budgetView: false }),
    ).toEqual(['PLANNER'])
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
    expect(permisosDe({ kind: 'member', role: 'COUPLE', owner: true, budgetView: false })).toEqual([
      'COUPLE',
      'OWNER',
      'BUDGET_VIEW',
      'BUDGET_EDIT',
    ])
  })

  it('un miembro no creador y un vendor no llevan permisos de presupuesto', () => {
    expect(
      permisosDe({ kind: 'member', role: 'PLANNER', owner: false, budgetView: false }),
    ).toEqual(['PLANNER'])
    expect(permisosDe({ kind: 'vendor', eventVendorId: 'x' })).toEqual(['VENDOR'])
  })

  it('un miembro con grant lleva BUDGET_VIEW pero no BUDGET_EDIT', () => {
    expect(permisosDe({ kind: 'member', role: 'PLANNER', owner: false, budgetView: true })).toEqual(
      ['PLANNER', 'BUDGET_VIEW'],
    )
  })
})
