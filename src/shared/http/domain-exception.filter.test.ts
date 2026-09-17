import { ArgumentsHost } from '@nestjs/common'

import { ConflictError, NotFoundError } from '../domain/domain-error'
import { DomainExceptionFilter } from './domain-exception.filter'

function hostFalso(): {
  host: ArgumentsHost
  json: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
} {
  const json = vi.fn()
  const status = vi.fn().mockReturnValue({ json })
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/events/1', requestId: 'req-1' }),
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
})
