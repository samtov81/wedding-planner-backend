import { describe, expect, it } from 'vitest'
import {
  alcanza,
  avanzar,
  claveDePar,
  MAX_CARACTERES_MENSAJE,
  normalizarCuerpo,
  parPermitido,
  type RolEnEvento,
} from './conversacion'
import { MensajeInvalidoError } from './messaging-errors'

const E = '11111111-1111-1111-1111-111111111111'
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

describe('claveDePar', () => {
  it('es simétrica: el orden de las personas no cambia la clave', () => {
    expect(claveDePar(E, A, B)).toBe(claveDePar(E, B, A))
  })

  it('pone primero el menor y distingue eventos', () => {
    expect(claveDePar(E, B, A)).toBe(`${E}:${A}:${B}`)
    expect(claveDePar('otro', A, B)).not.toBe(claveDePar(E, A, B))
  })
})

describe('parPermitido', () => {
  const roles: RolEnEvento[] = ['COUPLE', 'PLANNER', 'VENDOR']
  const combinaciones = roles.flatMap((a) => roles.map((b) => [a, b] as const))

  it.each(combinaciones)('%s con %s', (a, b) => {
    expect(parPermitido(a, b)).toBe(!(a === 'VENDOR' && b === 'VENDOR'))
  })
})

describe('normalizarCuerpo', () => {
  it('recorta los espacios de los extremos', () => {
    expect(normalizarCuerpo('  hola ')).toBe('hola')
  })

  it('rechaza un texto vacío o sólo de espacios', () => {
    expect(() => normalizarCuerpo('   ')).toThrow(MensajeInvalidoError)
    expect(() => normalizarCuerpo('')).toThrow(MensajeInvalidoError)
  })

  it('acepta 2000 caracteres y rechaza 2001', () => {
    expect(MAX_CARACTERES_MENSAJE).toBe(2000)
    expect(normalizarCuerpo('x'.repeat(2000))).toHaveLength(2000)
    expect(() => normalizarCuerpo('x'.repeat(2001))).toThrow(MensajeInvalidoError)
  })
})

describe('marcas', () => {
  const t0 = new Date('2026-01-01T10:00:00Z')
  const t1 = new Date('2026-01-01T10:00:01Z')

  it('avanzar parte de nada y se queda con la nueva', () => {
    expect(avanzar(null, { at: t0, id: 'a' })).toEqual({ at: t0, id: 'a' })
  })

  it('avanzar nunca retrocede', () => {
    expect(avanzar({ at: t1, id: 'a' }, { at: t0, id: 'z' })).toEqual({ at: t1, id: 'a' })
    expect(avanzar({ at: t0, id: 'a' }, { at: t1, id: 'a' })).toEqual({ at: t1, id: 'a' })
  })

  it('con el mismo instante decide el id', () => {
    expect(avanzar({ at: t0, id: 'b' }, { at: t0, id: 'a' })).toEqual({ at: t0, id: 'b' })
    expect(avanzar({ at: t0, id: 'a' }, { at: t0, id: 'b' })).toEqual({ at: t0, id: 'b' })
  })

  it('alcanza: sin marca no alcanza nada', () => {
    expect(alcanza(null, { at: t0, id: 'a' })).toBe(false)
  })

  it('alcanza: la marca cubre el mensaje igual o anterior', () => {
    expect(alcanza({ at: t0, id: 'b' }, { at: t0, id: 'b' })).toBe(true)
    expect(alcanza({ at: t1, id: 'a' }, { at: t0, id: 'z' })).toBe(true)
    expect(alcanza({ at: t0, id: 'a' }, { at: t0, id: 'b' })).toBe(false)
    expect(alcanza({ at: t0, id: 'z' }, { at: t1, id: 'a' })).toBe(false)
  })
})
