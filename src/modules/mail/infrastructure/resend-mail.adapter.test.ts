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
  })

  describe('conflicto de idempotencia (bloque A §5: cuenta como enviado)', () => {
    it.each(['invalid_idempotent_request', 'concurrent_idempotent_requests'])(
      'un %s NO lanza: el correo de esa clave ya salió',
      async (name) => {
        // Lanzar haría que el worker caducara una invitación cuyo enlace ya
        // está en la bandeja del invitado.
        enviar.mockResolvedValue({
          data: null,
          error: { name, statusCode: 409, message: 'idempotency key already used' },
        })

        // Enviado, pero sin id del proveedor: sus webhooks no podrán casarlo.
        expect(await adaptador.send(MENSAJE)).toEqual({})
      },
    )

    it('si el conflicto trae el id del correo original, ese id se devuelve', async () => {
      enviar.mockResolvedValue({
        data: { id: 're_original' },
        error: { name: 'invalid_idempotent_request', statusCode: 409, message: 'ya usada' },
      })

      expect(await adaptador.send(MENSAJE)).toEqual({ providerMessageId: 're_original' })
    })

    it('un 409 que NO es de idempotencia sigue siendo un error reintentable', async () => {
      // Se mira el código, no el HTTP: otro conflicto no dice que el correo
      // haya salido, y darlo por enviado se tragaría un envío de verdad.
      enviar.mockResolvedValue({
        data: null,
        error: { name: 'application_error', statusCode: 409, message: 'conflict' },
      })

      await expect(adaptador.send(MENSAJE)).rejects.toThrow('conflict')
    })

    it('una clave MALFORMADA no es un envío: se reintenta como cualquier otro error', async () => {
      // `invalid_idempotency_key` es un 400: la petición se rechazó y no salió
      // ningún correo, así que darla por enviada sería mentir.
      enviar.mockResolvedValue({
        data: null,
        error: { name: 'invalid_idempotency_key', statusCode: 400, message: 'clave inválida' },
      })

      await expect(adaptador.send(MENSAJE)).rejects.toThrow('clave inválida')
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
