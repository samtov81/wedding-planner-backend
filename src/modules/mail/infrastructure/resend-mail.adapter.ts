import { Inject, Injectable } from '@nestjs/common'
import { Resend } from 'resend'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import type { MailMessage, MailPort, MailResult } from '../application/mail.port'

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
    const { data, error } = await this.cliente.emails.send(
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

    // Se lanza para que BullMQ reintente. Un error del proveedor devuelto como
    // valor se traga en silencio y la invitación se queda en QUEUED para siempre.
    if (error !== null) throw new Error(`Resend rechazó el envío: ${error.message}`)
    if (data === null) throw new Error('Resend no devolvió id de mensaje')

    return { providerMessageId: data.id }
  }
}
