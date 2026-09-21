import { Inject, Injectable } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import { Resend } from 'resend'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import type { MailMessage, MailPort, MailResult } from '../application/mail.port'

/**
 * Lo que el SDK devuelve, ya sin el estrechamiento de su unión: en el tipo de
 * Resend, `data` es `null` siempre que hay `error`, así que sin esto no se
 * puede ni mirar si un 409 trae el id del correo original. La API sí podría
 * traerlo, y el SDK lo copia tal cual.
 */
interface RespuestaResend {
  data: { id: string } | null
  error: { name: string; statusCode: number | null; message: string } | null
}

@Injectable()
export class ResendMailAdapter implements MailPort {
  private readonly cliente: Resend

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.RESEND_API_KEY === undefined) {
      // Fail fast otra vez: MAIL_DRIVER=resend sin key es un despliegue roto
      // que sólo se notaría al intentar mandar el primer correo.
      throw new Error('MAIL_DRIVER=resend requiere RESEND_API_KEY')
    }
    this.cliente = new Resend(env.RESEND_API_KEY)
  }

  async send(mensaje: MailMessage): Promise<MailResult> {
    const respuesta: RespuestaResend = await this.cliente.emails.send(
      {
        from: this.env.MAIL_FROM,
        to: mensaje.to,
        subject: mensaje.subject,
        html: mensaje.html,
        text: mensaje.text,
        ...(mensaje.tags !== undefined
          ? { tags: Object.entries(mensaje.tags).map(([name, value]) => ({ name, value })) }
          : {}),
      },
      mensaje.idempotencyKey !== undefined ? { idempotencyKey: mensaje.idempotencyKey } : {},
    )

    if (respuesta.error !== null) {
      // 409 = la clave de idempotencia ya se usó (`invalid_idempotent_request`
      // con otro contenido, `concurrent_idempotent_requests` a la vez). El
      // correo de esa clave YA salió o está saliendo: repetir la petición da
      // otro 409, así que reintentar cinco veces no arregla nada.
      if (esConflictoDeIdempotencia(respuesta.error)) {
        // Si la API devuelve el id del correo original, eso es un envío: se
        // devuelve para que el webhook pueda casarlo.
        if (respuesta.data !== null) return { providerMessageId: respuesta.data.id }
        // Sin id no hay nada que guardar ni que casar: se falla SIN reintentos.
        // El worker lo trata como último intento y caduca la invitación, que es
        // preferible a cinco 409 y un token vivo en los fallidos de Redis.
        throw new UnrecoverableError('Resend: clave de idempotencia ya usada con otro contenido')
      }
      // Se lanza para que BullMQ reintente. Un error del proveedor devuelto como
      // valor se traga en silencio y la invitación se queda en QUEUED para siempre.
      throw new Error(`Resend rechazó el envío: ${respuesta.error.message}`)
    }
    if (respuesta.data === null) throw new Error('Resend no devolvió id de mensaje')

    return { providerMessageId: respuesta.data.id }
  }
}

/**
 * Por el HTTP, no por el código: `statusCode` 409 es el conflicto de
 * idempotencia (`invalid_idempotent_request`, `concurrent_idempotent_requests`)
 * y cualquier otro conflicto que Resend añada, que tampoco se arregla
 * repitiendo la misma petición.
 */
function esConflictoDeIdempotencia(error: { statusCode: number | null }): boolean {
  return error.statusCode === 409
}
