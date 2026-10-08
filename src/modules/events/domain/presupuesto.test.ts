import { describe, expect, it } from 'vitest'

import { accesoAlPresupuesto, accesoAlPresupuestoEnListado } from './presupuesto'

describe('accesoAlPresupuesto', () => {
  it.each([
    [{ kind: 'admin' } as const, 'edit'],
    [{ kind: 'member', role: 'COUPLE', owner: true } as const, 'edit'],
    [{ kind: 'member', role: 'COUPLE', owner: false } as const, 'none'],
    [{ kind: 'member', role: 'PLANNER', owner: false } as const, 'none'],
    [{ kind: 'vendor', eventVendorId: 'ev-v' } as const, 'none'],
    [{ kind: 'none' } as const, 'none'],
  ])('%o → %s', (acceso, esperado) => {
    expect(accesoAlPresupuesto(acceso)).toBe(esperado)
  })
})

describe('accesoAlPresupuestoEnListado', () => {
  it('el creador edita; cualquier otro no ve nada', () => {
    expect(accesoAlPresupuestoEnListado('u-1', 'u-1')).toBe('edit')
    expect(accesoAlPresupuestoEnListado('u-1', 'u-2')).toBe('none')
  })
})
