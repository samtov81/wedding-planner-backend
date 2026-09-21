import { Inject, Injectable } from '@nestjs/common'
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
      // Un conflicto de idempotencia CUENTA COMO ENVIADO (bloque A §5): esa
      // clave ya produjo un correo —salido, o saliendo en la petición gemela—,
      // y es exactamente el correo que íbamos a mandar. Lanzar aquí haría que
      // el worker caducara una invitación cuyo enlace ya está en la bandeja del
      // invitado, que es justo lo contrario de lo que pasó.
      if (esConflictoDeIdempotencia(respuesta.error)) {
        // Si la API devuelve el id del correo original, se devuelve para que el
        // webhook pueda casarlo. Hoy no lo hace —con `error`, `data` viene
        // `null`—, y entonces el envío consta sin id: la invitación se marca
        // SENT sin `resendMessageId` y sus webhooks de entrega no la avanzan.
        if (respuesta.data !== null) return { providerMessageId: respuesta.data.id }
        return {}
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
 * Los dos códigos con los que Resend dice que esa clave YA produjo un correo:
 * `invalid_idempotent_request` (misma clave, contenido distinto) y
 * `concurrent_idempotent_requests` (la petición gemela está en vuelo). Por el
 * CÓDIGO y no por el 409 a secas: otro conflicto distinto no dice que el correo
 * haya salido, y darlo por enviado se tragaría un envío de verdad.
 *
 * `invalid_idempotency_key` queda FUERA a propósito: es un 400 por una clave
 * malformada, la petición se rechazó y no salió ningún correo.
 */
const CONFLICTOS_DE_IDEMPOTENCIA = ['invalid_idempotent_request', 'concurrent_idempotent_requests']

function esConflictoDeIdempotencia(error: { name: string }): boolean {
  return CONFLICTOS_DE_IDEMPOTENCIA.includes(error.name)
}
