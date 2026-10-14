import { describe, expect, it } from 'vitest'

import { accesoAlPresupuesto, accesoAlPresupuestoEnListado } from './presupuesto'

const miembro = (owner: boolean, budgetView: boolean, role: 'COUPLE' | 'PLANNER' = 'COUPLE') =>
  ({ kind: 'member', role, owner, budgetView }) as const

describe('accesoAlPresupuesto', () => {
  it.each([
    [{ kind: 'admin' } as const, 'edit'],
    [miembro(true, false), 'edit'],
    // Un grant en la fila del creador no le baja a `view`: el creador edita.
    [miembro(true, true), 'edit'],
    [miembro(false, false), 'none'],
    [miembro(false, true), 'view'],
    [miembro(false, true, 'PLANNER'), 'view'],
    [miembro(false, false, 'PLANNER'), 'none'],
    [{ kind: 'vendor', eventVendorId: 'ev-v' } as const, 'none'],
    [{ kind: 'none' } as const, 'none'],
  ])('%o → %s', (acceso, esperado) => {
    expect(accesoAlPresupuesto(acceso)).toBe(esperado)
  })
})

describe('accesoAlPresupuestoEnListado', () => {
  it('el creador edita, un miembro con grant ve y el resto no ve nada', () => {
    expect(accesoAlPresupuestoEnListado('u-1', 'u-1', false)).toBe('edit')
    expect(accesoAlPresupuestoEnListado('u-1', 'u-2', true)).toBe('view')
    expect(accesoAlPresupuestoEnListado('u-1', 'u-2', false)).toBe('none')
  })

  it('coincide con accesoAlPresupuesto para todo miembro posible', () => {
    // Las dos reglas no pueden derivar: el listado y el evento suelto tienen
    // que enseñar lo mismo a la misma persona.
    for (const owner of [true, false]) {
      for (const budgetView of [true, false]) {
        expect(
          accesoAlPresupuestoEnListado('u-1', owner ? 'u-1' : 'u-2', budgetView),
          `owner=${owner} budgetView=${budgetView}`,
        ).toBe(accesoAlPresupuesto(miembro(owner, budgetView)))
      }
    }
  })
})
