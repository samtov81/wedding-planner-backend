import type { Marca } from './conversacion'
import { claveDeSala, lectoresDe, resumenDeLectura, type MarcasDe } from './sala'

const T = new Date('2026-11-02T10:00:00.000Z')
const marca = (id: string, ms = 0): Marca => ({ at: new Date(T.getTime() + ms), id })

describe('claveDeSala', () => {
  it('es room:<eventId>', () => {
    expect(claveDeSala('e1')).toBe('room:e1')
  })
})

describe('resumenDeLectura', () => {
  const mensaje = marca('m5')

  it('cuenta sólo a los destinatarios: un no destinatario con marca mayor no suma', () => {
    const marcas = new Map<string, MarcasDe>([
      ['a', { deliveredUpTo: marca('m9'), readUpTo: marca('m5') }],
      ['b', { deliveredUpTo: marca('m5'), readUpTo: null }],
      ['intruso', { deliveredUpTo: marca('m9'), readUpTo: marca('m9') }],
    ])
    expect(resumenDeLectura(['a', 'b', 'c'], marcas, mensaje)).toEqual({
      total: 3,
      delivered: 2,
      read: 1,
    })
  })

  it('un destinatario sin marcas no lo ha recibido ni leído', () => {
    expect(resumenDeLectura(['a'], new Map(), mensaje)).toEqual({
      total: 1,
      delivered: 0,
      read: 0,
    })
  })

  it('con el mismo instante decide el id', () => {
    const marcas = new Map<string, MarcasDe>([
      ['a', { deliveredUpTo: marca('m4'), readUpTo: marca('m4') }],
      ['b', { deliveredUpTo: marca('m6'), readUpTo: marca('m6') }],
    ])
    expect(resumenDeLectura(['a', 'b'], marcas, mensaje)).toEqual({
      total: 2,
      delivered: 1,
      read: 1,
    })
  })
})

describe('lectoresDe', () => {
  it('reparte en leídos y pendientes conservando el orden de los destinatarios', () => {
    const marcas = new Map<string, MarcasDe>([
      ['c', { deliveredUpTo: null, readUpTo: marca('m1', 1) }],
      ['a', { deliveredUpTo: null, readUpTo: marca('m1', -1) }],
      ['b', { deliveredUpTo: null, readUpTo: marca('m1', 5) }],
    ])
    expect(lectoresDe(['a', 'b', 'c', 'd'], marcas, marca('m1'))).toEqual({
      read: ['b', 'c'],
      unread: ['a', 'd'],
    })
  })
})
