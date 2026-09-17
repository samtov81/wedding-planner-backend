import { decodeCursor, encodeCursor, InvalidCursorError } from './cursor'

describe('cursor de paginación', () => {
  it('sobrevive a un viaje de ida y vuelta', () => {
    const original = { createdAt: new Date('2026-09-17T10:30:00.000Z'), id: 'abc-123' }

    expect(decodeCursor(encodeCursor(original))).toEqual(original)
  })

  it('es opaco: no revela el id en claro', () => {
    expect(encodeCursor({ createdAt: new Date(), id: 'abc-123' })).not.toContain('abc-123')
  })

  it('rechaza un cursor manipulado en vez de devolver basura', () => {
    expect(() => decodeCursor('no-es-base64-valido!!')).toThrow(InvalidCursorError)
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(InvalidCursorError)
  })
})
