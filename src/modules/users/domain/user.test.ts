import { normalizarEmail } from './user'

describe('normalizarEmail', () => {
  it('baja a minúsculas y recorta', () => {
    expect(normalizarEmail('  Ana@Test.COM ')).toBe('ana@test.com')
  })

  it('hace que dos grafías del mismo buzón colisionen en el índice único', () => {
    expect(normalizarEmail('ANA@test.com')).toBe(normalizarEmail('ana@TEST.com'))
  })
})
