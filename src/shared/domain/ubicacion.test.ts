import { crearUbicacion, UbicacionInvalidaError } from './ubicacion'

describe('crearUbicacion', () => {
  it('normaliza vacíos a null y recorta la dirección', () => {
    expect(
      crearUbicacion({ name: '  ', address: '  Calle 1 #2-3, Bogotá ', lat: 4.6, lng: -74.08 }),
    ).toEqual({
      name: null,
      address: 'Calle 1 #2-3, Bogotá',
      lat: 4.6,
      lng: -74.08,
      mapboxId: null,
    })
  })

  it.each([
    [{ address: '', lat: 0, lng: 0 }],
    [{ address: 'X', lat: 91, lng: 0 }],
    [{ address: 'X', lat: 0, lng: -181 }],
    [{ address: 'X', lat: Number.NaN, lng: 0 }],
    [{ address: 'X', lat: 0, lng: Number.POSITIVE_INFINITY }],
  ])('rechaza %o', (entrada) => {
    expect(() => crearUbicacion(entrada)).toThrow(UbicacionInvalidaError)
  })
})
