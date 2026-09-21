import { hashToken } from '../application/token.service'
import {
  HORAS_DE_VALIDEZ_VERIFICACION,
  caducidadVerificacion,
  generarTokenVerificacion,
} from './email-verification'

describe('generarTokenVerificacion', () => {
  it('devuelve base64url de 32 bytes: ni relleno `=` ni `+/` que romperían la URL', () => {
    const token = generarTokenVerificacion()

    // 32 bytes en base64url son 43 caracteres sin relleno. El token viaja como
    // query param del enlace del correo: un `+` o un `/` se reinterpretarían al
    // parsear la URL y el usuario vería "inválido o caducado" con un token bueno.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('no repite: dos llamadas seguidas dan tokens distintos', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generarTokenVerificacion()))

    expect(tokens.size).toBe(50)
  })

  it('el token en claro no se parece a su hash: lo que se persiste no sirve para verificar', () => {
    // La tabla guarda SÓLO el hash (mismo patrón que la invitación de invitado):
    // un volcado de la base de datos no entrega ningún enlace utilizable.
    const token = generarTokenVerificacion()

    expect(hashToken(token)).not.toBe(token)
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('caducidadVerificacion', () => {
  const DESDE = new Date('2026-03-01T10:00:00.000Z')

  it('suma las horas pedidas a la fecha de partida', () => {
    expect(caducidadVerificacion(48, DESDE).toISOString()).toBe('2026-03-03T10:00:00.000Z')
  })

  it('no muta la fecha de partida', () => {
    caducidadVerificacion(48, DESDE)

    expect(DESDE.toISOString()).toBe('2026-03-01T10:00:00.000Z')
  })

  it('sin fecha de partida cuenta desde ahora', () => {
    const antes = Date.now()
    const caducidad = caducidadVerificacion(1)

    expect(caducidad.getTime()).toBeGreaterThanOrEqual(antes + 3_600_000)
    expect(caducidad.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000)
  })

  it('el valor por defecto del módulo son 48 horas', () => {
    // 48h: margen suficiente si el correo cae en la cuarentena de spam de una
    // empresa, sin dejar vivo semanas un token sin consumir.
    expect(HORAS_DE_VALIDEZ_VERIFICACION).toBe(48)
  })
})
