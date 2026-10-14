import { describe, expect, it } from 'vitest'

import { exigirGestionable, exigirInvitacionPendiente } from './membresia'

/**
 * Lo que lanza `fn`, o `undefined` si no lanza. `toThrow(expect.objectContaining(...))`
 * diría lo mismo, pero `objectContaining` es `any` y ESLint lo rechaza como argumento.
 */
function errorDe(fn: () => void): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('exigirGestionable', () => {
  it('deja pasar a un miembro INVITED o ACTIVE que no es el creador', () => {
    expect(() => exigirGestionable({ status: 'INVITED', owner: false })).not.toThrow()
    expect(() => exigirGestionable({ status: 'ACTIVE', owner: false })).not.toThrow()
  })

  it('una membresía que no existe o está REVOKED es 404: no se lista, no se gestiona', () => {
    expect(errorDe(() => exigirGestionable(null))).toMatchObject({
      code: 'MEMBER_NOT_FOUND',
      httpStatus: 404,
    })
    expect(errorDe(() => exigirGestionable({ status: 'REVOKED', owner: false }))).toMatchObject({
      code: 'MEMBER_NOT_FOUND',
    })
  })

  it('la fila del creador es intocable: 422', () => {
    expect(errorDe(() => exigirGestionable({ status: 'ACTIVE', owner: true }))).toMatchObject({
      code: 'OWNER_MEMBERSHIP_IMMUTABLE',
      httpStatus: 422,
    })
  })
})

describe('exigirInvitacionPendiente', () => {
  it('sólo una INVITED se acepta o rechaza', () => {
    expect(() => exigirInvitacionPendiente({ status: 'INVITED' })).not.toThrow()
  })

  it.each([null, { status: 'ACTIVE' as const }, { status: 'REVOKED' as const }])(
    '%o es 404 NO_PENDING_INVITATION',
    (m) => {
      expect(errorDe(() => exigirInvitacionPendiente(m))).toMatchObject({
        code: 'NO_PENDING_INVITATION',
        httpStatus: 404,
      })
    },
  )
})
