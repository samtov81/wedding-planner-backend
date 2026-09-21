import { decodeCursor, encodeCursor, InvalidCursorError } from './cursor'

describe('cursor de paginación', () => {
  const unUuid = '9f2c1e3a-4b5d-4e6f-8a9b-0c1d2e3f4a5b'

  it('sobrevive a un viaje de ida y vuelta', () => {
    const original = { createdAt: new Date('2026-09-17T10:30:00.000Z'), id: unUuid }

    expect(decodeCursor(encodeCursor(original))).toEqual(original)
  })

  it('es opaco: no revela el id en claro', () => {
    expect(encodeCursor({ createdAt: new Date(), id: unUuid })).not.toContain(unUuid)
  })

  it('rechaza un cursor manipulado en vez de devolver basura', () => {
    expect(() => decodeCursor('no-es-base64-valido!!')).toThrow(InvalidCursorError)
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(InvalidCursorError)
  })

  it('rechaza un cursor con un id que no es UUID: no puede existir en la tabla', () => {
    expect(() => decodeCursor(encodeCursor({ createdAt: new Date(), id: 'x' }))).toThrow(
      InvalidCursorError,
    )
  })
})
