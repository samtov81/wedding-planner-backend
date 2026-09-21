import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import type { MailMessage, MailPort, MailResult } from '../application/mail.port'

/**
 * Adaptador de desarrollo y de test. En test se asserta sobre `enviados`; en
 * desarrollo evita que un `npm run dev` mande correo real a direcciones de
 * prueba, que es un accidente caro de deshacer.
 */
@Injectable()
export class FakeMailAdapter implements MailPort {
  readonly enviados: MailMessage[] = []
  private fallo: Error | null = null
  private readonly porClave = new Map<string, string>()

  /** Hace fallar SÓLO el siguiente envío: así se prueban los reintentos. */
  fallarProximoEnvio(error: Error): void {
    this.fallo = error
  }

  send(mensaje: MailMessage): Promise<MailResult> {
    if (this.fallo !== null) {
      const error = this.fallo
      this.fallo = null
      return Promise.reject(error)
    }

    // Misma clave, mismo resultado y ningún correo nuevo: como `Idempotency-Key`.
    const previo =
      mensaje.idempotencyKey === undefined ? undefined : this.porClave.get(mensaje.idempotencyKey)
    if (previo !== undefined) return Promise.resolve({ providerMessageId: previo })

    this.enviados.push(mensaje)
    const providerMessageId = `fake-${randomUUID()}`
    if (mensaje.idempotencyKey !== undefined) {
      this.porClave.set(mensaje.idempotencyKey, providerMessageId)
    }
    return Promise.resolve({ providerMessageId })
  }
}
