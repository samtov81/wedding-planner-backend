import { aCentimos, deCentimos, MontoInvalidoError, normalizarMonto } from './monto'

describe('normalizarMonto', () => {
  it.each([
    [1500, '1500.00'],
    ['1500', '1500.00'],
    ['1500.5', '1500.50'],
    [0.1, '0.10'],
    ['0', '0.00'],
    [' 12.34 ', '12.34'],
    [9_999_999_999.99, '9999999999.99'],
  ])('%p → %p', (entrada, esperado) => {
    expect(normalizarMonto(entrada)).toBe(esperado)
  })

  it.each([
    ['1,500'],
    ['12.345'],
    [-1],
    ['-1'],
    [1e21],
    ['abc'],
    [''],
    [Number.NaN],
    ['1e3'],
    [10_000_000_000],
  ])('rechaza %p', (entrada) => {
    expect(() => normalizarMonto(entrada)).toThrow(MontoInvalidoError)
  })
})

describe('céntimos', () => {
  it('ida y vuelta exacta', () => {
    expect(aCentimos('45000.00')).toBe(4_500_000n)
    expect(deCentimos(4_500_000n)).toBe('45000.00')
  })

  it('deCentimos admite negativos (lo que queda puede ser negativo)', () => {
    expect(deCentimos(-150n)).toBe('-1.50')
    expect(deCentimos(-5n)).toBe('-0.05')
  })

  it('suma sin error de coma flotante', () => {
    expect(deCentimos(aCentimos('0.10') + aCentimos('0.20'))).toBe('0.30')
  })
})
