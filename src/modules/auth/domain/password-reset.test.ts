import { caducidadReset, generarTokenReset } from './password-reset'

describe('password-reset (dominio)', () => {
  it('genera 32 bytes aleatorios en base64url, distintos en cada llamada', () => {
    const a = generarTokenReset()
    const b = generarTokenReset()

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('la caducidad se cuenta en minutos desde el instante dado', () => {
    const desde = new Date('2026-09-22T10:00:00.000Z')

    expect(caducidadReset(30, desde)).toEqual(new Date('2026-09-22T10:30:00.000Z'))
  })
})
