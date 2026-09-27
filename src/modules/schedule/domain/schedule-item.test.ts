import { rangoValido } from './schedule-item'

describe('rangoValido', () => {
  const a = new Date('2027-06-12T20:00:00Z')
  it('sin fin es válido', () => expect(rangoValido(a, null)).toBe(true))
  it('fin igual al inicio es válido', () => expect(rangoValido(a, a)).toBe(true))
  it('fin antes del inicio no es válido', () =>
    expect(rangoValido(a, new Date('2027-06-12T19:59:59Z'))).toBe(false))
})
