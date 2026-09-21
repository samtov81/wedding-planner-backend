import { UnrecoverableError } from 'bullmq'

import type { Env } from '@/config/env.schema'

import { ResendMailAdapter } from './resend-mail.adapter'

/**
 * El SDK de Resend NUNCA lanza: devuelve `{ data, error }`, y en el error
 * copia tal cual lo que responde la API (`name` = código de la API,
 * `statusCode` = el HTTP). Este doble sustituye al cliente entero para poder
 * devolver esas formas sin red.
 */
const { enviar } = vi.hoisted(() => ({ enviar: vi.fn() }))

vi.mock('resend', () => ({
  Resend: class {
    readonly emails = { send: enviar }
  },
}))

const MENSAJE = {
  to: 'ana@test.com',
  subject: 'You are invited',
  html: '<p>hola</p>',
  text: 'hola',
  idempotencyKey: 'invitation-inv-1',
}

describe('ResendMailAdapter', () => {
  let adaptador: ResendMailAdapter

  beforeEach(() => {
    enviar.mockReset()
    adaptador = new ResendMailAdapter({
      RESEND_API_KEY: 're_test',
      MAIL_FROM: 'no-reply@boda.test',
    } as Env)
  })

  it('devuelve el id del proveedor de un envío correcto', async () => {
    enviar.mockResolvedValue({ data: { id: 're_123' }, error: null })

    expect(await adaptador.send(MENSAJE)).toEqual({ providerMessageId: 're_123' })
  })

  it('manda la clave de idempotencia en las opciones de la petición', async () => {
    enviar.mockResolvedValue({ data: { id: 're_123' }, error: null })

    await adaptador.send(MENSAJE)

    expect(enviar.mock.calls[0]?.[1]).toEqual({ idempotencyKey: 'invitation-inv-1' })
  })

  it('lanza ante un error del proveedor, para que BullMQ reintente', async () => {
    enviar.mockResolvedValue({
      data: null,
      error: { name: 'internal_server_error', statusCode: 500, message: 'boom' },
    })

    await expect(adaptador.send(MENSAJE)).rejects.toThrow('boom')
    // Reintentable: NO es un `UnrecoverableError`.
    await expect(adaptador.send(MENSAJE)).rejects.not.toBeInstanceOf(UnrecoverableError)
  })

  describe('conflicto de idempotencia (409)', () => {
    it.each(['invalid_idempotent_request', 'concurrent_idempotent_requests'])(
      'un %s sin id no se reintenta: cinco intentos darían el mismo 409',
      async (name) => {
        enviar.mockResolvedValue({
          data: null,
          error: { name, statusCode: 409, message: 'idempotency key already used' },
        })

        await expect(adaptador.send(MENSAJE)).rejects.toBeInstanceOf(UnrecoverableError)
      },
    )

    it('si el conflicto trae el id del correo original, cuenta como enviado', async () => {
      // La API puede contestar el 409 con el mensaje que sí salió con esa
      // clave: ese correo ESTÁ enviado, y su id es el que el webhook va a casar.
      enviar.mockResolvedValue({
        data: { id: 're_original' },
        error: { name: 'invalid_idempotent_request', statusCode: 409, message: 'ya usada' },
      })

      expect(await adaptador.send(MENSAJE)).toEqual({ providerMessageId: 're_original' })
    })

    it('un 409 de otra familia también se da por perdido sin reintentar', async () => {
      // El `statusCode` manda: un conflicto no lo arregla repetir la petición.
      enviar.mockResolvedValue({
        data: null,
        error: { name: 'application_error', statusCode: 409, message: 'conflict' },
      })

      await expect(adaptador.send(MENSAJE)).rejects.toBeInstanceOf(UnrecoverableError)
    })
  })

  it('un 200 sin datos es un error del proveedor, no un envío bueno', async () => {
    enviar.mockResolvedValue({ data: null, error: null })

    await expect(adaptador.send(MENSAJE)).rejects.toThrow('no devolvió id')
  })

  it('sin RESEND_API_KEY el adaptador no se construye', () => {
    expect(() => new ResendMailAdapter({ MAIL_FROM: 'no-reply@boda.test' } as Env)).toThrow(
      'RESEND_API_KEY',
    )
  })
})
