import jwt from 'jsonwebtoken'

import { hashToken, TokenService } from './token.service'

describe('TokenService', () => {
  const secreto = 'x'.repeat(32)
  const servicio = new TokenService({
    JWT_ACCESS_SECRET: secreto,
    JWT_ACCESS_TTL: '15m',
    REFRESH_TTL_DAYS: 30,
  })

  it('rechaza un token firmado con otro algoritmo', () => {
    // Con el mismo secreto, HS512 es una firma VÁLIDA para `jsonwebtoken` si
    // no se fija el algoritmo: aceptarla es dejar que el token elija cómo se
    // comprueba a sí mismo.
    const ajeno = jwt.sign({ sub: 'u', role: 'USER' }, secreto, { algorithm: 'HS512' })
    expect(() => servicio.verificarAccess(ajeno)).toThrow()
  })

  it('firma y verifica un token de acceso, con su caducidad', () => {
    // El `exp` sale del token, no del reloj de quien lo lee: es lo que deja al
    // gateway de sockets programar la desconexión exacta.
    const token = servicio.firmarAccess({ id: 'u-1', systemRole: 'USER' })
    expect(servicio.verificarAccess(token)).toEqual({
      sub: 'u-1',
      role: 'USER',
      exp: expect.any(Number) as number,
    })
    expect(servicio.verificarAccess(token).exp).toBeCloseTo(Date.now() / 1000 + 900, -1)
  })

  it('rechaza un token bien firmado pero sin caducidad', () => {
    // `noTimestamp` + sin `expiresIn`: un token eterno. Sin `exp` no hay
    // desconexión que programar, así que no se acepta.
    const eterno = jwt.sign({ sub: 'u-1', role: 'USER' }, secreto, { algorithm: 'HS256' })
    expect(() => servicio.verificarAccess(eterno)).toThrow(/inválido/i)
  })

  it('firma con HS256', () => {
    const token = servicio.firmarAccess({ id: 'u-1', systemRole: 'USER' })
    expect(jwt.decode(token, { complete: true })?.header.alg).toBe('HS256')
  })

  it('el refresh es opaco y su hash no es el token', () => {
    const { token, hash } = servicio.generarRefresh()
    expect(hash).toBe(hashToken(token))
    expect(hash).not.toContain(token)
  })
})
