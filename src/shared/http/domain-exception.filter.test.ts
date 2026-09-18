import { inspect } from 'node:util'

import { ArgumentsHost, Logger } from '@nestjs/common'

import { ConflictError, NotFoundError } from '../domain/domain-error'
import { DomainExceptionFilter } from './domain-exception.filter'

function hostFalso(url = '/events/1'): {
  host: ArgumentsHost
  json: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
} {
  const json = vi.fn()
  const status = vi.fn().mockReturnValue({ json })
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, requestId: 'req-1' }),
    }),
  } as unknown as ArgumentsHost

  return { host, json, status }
}

describe('DomainExceptionFilter', () => {
  it('traduce un error de dominio a su código HTTP y su code estable', () => {
    const { host, json, status } = hostFalso()

    new DomainExceptionFilter().catch(new NotFoundError('El evento no existe'), host)

    expect(status).toHaveBeenCalledWith(404)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'NOT_FOUND',
        message: 'El evento no existe',
        requestId: 'req-1',
      }),
    )
  })

  it('nunca incluye el stack en la respuesta', () => {
    const { host, json } = hostFalso()

    new DomainExceptionFilter().catch(new ConflictError('Ya existe'), host)

    expect(JSON.stringify(json.mock.calls[0])).not.toMatch(/at .*\.ts:/)
  })

  it('convierte un error desconocido en 500 sin filtrar su mensaje', () => {
    const { host, json, status } = hostFalso()

    new DomainExceptionFilter().catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host)

    expect(status).toHaveBeenCalledWith(500)
    expect(json.mock.calls[0]?.[0]).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(JSON.stringify(json.mock.calls[0])).not.toContain('10.0.0.5')
  })

  describe('el token del RSVP público nunca llega al log', () => {
    // El token viaja en el PATH (`/rsvp/:token`) y es la única credencial de
    // esa ruta. Un 500 registra la URL: sin tachar, el sistema de logs se
    // convierte en un almacén de enlaces válidos para responder por otros.
    const TOKEN = 'Q2FzaVNlY3JldG9EZUxhSW52aXRhY2lvbkRlQW5hMTIz'

    afterEach(() => vi.restoreAllMocks())

    it.each([`/rsvp/${TOKEN}`, `/rsvp/${TOKEN}?utm=mail`, `/rsvp/${TOKEN}/`])(
      'tacha el token de %s en el log de un 500',
      (url) => {
        const registro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
        const { host } = hostFalso(url)

        new DomainExceptionFilter().catch(new Error('fallo interno'), host)

        expect(registro).toHaveBeenCalledTimes(1)
        const registrado = inspect(registro.mock.calls, { depth: null })
        expect(registrado).not.toContain(TOKEN)
        expect(registrado).toContain('/rsvp/[REDACTADO]')
      },
    )

    it('también con otras mayúsculas, que Express enruta al mismo controlador', () => {
      const registro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const { host } = hostFalso(`/RSVP/${TOKEN}`)

      new DomainExceptionFilter().catch(new Error('fallo interno'), host)

      expect(inspect(registro.mock.calls, { depth: null })).not.toContain(TOKEN)
    })

    it('no toca las URL que no llevan secretos', () => {
      const registro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const { host } = hostFalso('/events/1/guests?rsvp=PENDING')

      new DomainExceptionFilter().catch(new Error('fallo interno'), host)

      expect(inspect(registro.mock.calls, { depth: null })).toContain(
        '/events/1/guests?rsvp=PENDING',
      )
    })
  })
})
