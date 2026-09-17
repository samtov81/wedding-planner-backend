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

    this.enviados.push(mensaje)
    return Promise.resolve({ providerMessageId: `fake-${randomUUID()}` })
  }
}
