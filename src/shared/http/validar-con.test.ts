import { BadRequestException } from '@nestjs/common'
import { z } from 'zod'

import { DomainExceptionFilter } from './domain-exception.filter'
import { validarCon } from './validar-con'

const esquema = z.object({
  email: z.email('email debe ser un correo válido'),
  name: z.string().min(1, 'name no puede estar vacío'),
})

describe('validarCon', () => {
  it('devuelve el valor ya tipado cuando cumple el esquema', () => {
    expect(validarCon(esquema, { email: 'ana@test.com', name: 'Ana' })).toEqual({
      email: 'ana@test.com',
      name: 'Ana',
    })
  })

  it('lanza 400 y concatena TODOS los mensajes, no sólo el primero', () => {
    let capturado: unknown
    try {
      validarCon(esquema, { email: 'no-es-un-email', name: '' })
    } catch (error) {
      capturado = error
    }

    expect(capturado).toBeInstanceOf(BadRequestException)
    expect((capturado as BadRequestException).getStatus()).toBe(400)
    expect((capturado as BadRequestException).message).toBe(
      'email debe ser un correo válido; name no puede estar vacío',
    )
  })

  it('relanza intacto lo que no es un ZodError: no todo fallo es del cliente', () => {
    const revienta = {
      parse: (): never => {
        throw new TypeError('el esquema está roto')
      },
    }

    expect(() => validarCon(revienta, {})).toThrow(TypeError)
  })

  /**
   * El contrato completo del 400 tal como lo ve el cliente: `validarCon`
   * produce la excepción y `DomainExceptionFilter` la serializa. Ahora que el
   * helper lo comparte todo el borde, su forma deja de ser un detalle local.
   */
  it('sale por el filtro global como { code: HTTP_ERROR, message } ', () => {
    let cuerpo: unknown
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/events' }),
        getResponse: () => ({
          status: () => ({
            json: (json: unknown) => {
              cuerpo = json
            },
          }),
        }),
      }),
    }

    try {
      validarCon(esquema, { email: 'x', name: '' })
    } catch (error) {
      new DomainExceptionFilter().catch(error, host as never)
    }

    expect(cuerpo).toMatchObject({
      code: 'HTTP_ERROR',
      message: 'email debe ser un correo válido; name no puede estar vacío',
    })
  })
})
