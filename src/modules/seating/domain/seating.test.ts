import {
  armarDistribucion,
  esSobrante,
  type InvitadoSentable,
  type Mesa,
  plazasDe,
  posicionEnCuadricula,
  rangoAsientosValido,
} from './seating'

const invitado = (cambios: Partial<InvitadoSentable> = {}): InvitadoSentable => ({
  id: 'g1',
  rsvp: 'CONFIRMED',
  companionsAllowed: 2,
  companionsConfirmed: null,
  ...cambios,
})

describe('plazasDe', () => {
  it('un DECLINED no ocupa asientos', () =>
    expect(plazasDe(invitado({ rsvp: 'DECLINED' }))).toBe(0))
  it('un PENDING reserva el cupo permitido', () =>
    expect(plazasDe(invitado({ rsvp: 'PENDING' }))).toBe(3))
  it('un CONFIRMED sin respuesta de acompañantes reserva el cupo permitido', () =>
    expect(plazasDe(invitado())).toBe(3))
  it('un CONFIRMED con acompañantes confirmados usa esos', () =>
    expect(plazasDe(invitado({ companionsConfirmed: 1 }))).toBe(2))
})

describe('esSobrante', () => {
  it('el titular de un DECLINED sobra', () =>
    expect(esSobrante({ guestId: 'g1', companionIndex: 0 }, invitado({ rsvp: 'DECLINED' }))).toBe(
      true,
    ))
  it('un acompañante por encima de lo confirmado sobra', () =>
    expect(
      esSobrante({ guestId: 'g1', companionIndex: 2 }, invitado({ companionsConfirmed: 1 })),
    ).toBe(true))
  it('un acompañante dentro del cupo no sobra', () =>
    expect(esSobrante({ guestId: 'g1', companionIndex: 2 }, invitado())).toBe(false))
})

describe('rangoAsientosValido', () => {
  it('acepta 1 ≤ mín ≤ asientos ≤ máx ≤ 20', () =>
    expect(rangoAsientosValido({ minSeats: 4, seatCount: 6, maxSeats: 8 })).toBe(true))
  it('rechaza asientos por debajo del mínimo', () =>
    expect(rangoAsientosValido({ minSeats: 4, seatCount: 3, maxSeats: 8 })).toBe(false))
  it('rechaza asientos por encima del máximo', () =>
    expect(rangoAsientosValido({ minSeats: 4, seatCount: 9, maxSeats: 8 })).toBe(false))
  it('rechaza un máximo de más de 20', () =>
    expect(rangoAsientosValido({ minSeats: 4, seatCount: 4, maxSeats: 21 })).toBe(false))
  it('rechaza un mínimo de 0', () =>
    expect(rangoAsientosValido({ minSeats: 0, seatCount: 0, maxSeats: 4 })).toBe(false))
})

describe('posicionEnCuadricula', () => {
  it('llena cinco columnas y pasa a la fila siguiente', () => {
    expect(posicionEnCuadricula(0)).toEqual({ x: 40, y: 40 })
    expect(posicionEnCuadricula(4)).toEqual({ x: 920, y: 40 })
    expect(posicionEnCuadricula(5)).toEqual({ x: 40, y: 260 })
  })
})

describe('armarDistribucion', () => {
  it('dibuja cada asiento, ocupado o libre, y marca los sobrantes', () => {
    const mesa: Mesa = {
      id: 't1',
      eventId: 'e',
      name: 'Mesa 1',
      minSeats: 2,
      maxSeats: 4,
      seatCount: 3,
      x: 0,
      y: 0,
      createdAt: new Date(),
    }
    const [vista] = armarDistribucion(
      [mesa],
      [
        { tableId: 't1', seatIndex: 0, guestId: 'g1', companionIndex: 0 },
        { tableId: 't1', seatIndex: 2, guestId: 'g1', companionIndex: 2 },
      ],
      [invitado({ companionsConfirmed: 1 })],
    )
    expect(vista?.seats).toEqual([
      { index: 0, occupant: { guestId: 'g1', companionIndex: 0, sobrante: false } },
      { index: 1, occupant: null },
      { index: 2, occupant: { guestId: 'g1', companionIndex: 2, sobrante: true } },
    ])
  })
})
