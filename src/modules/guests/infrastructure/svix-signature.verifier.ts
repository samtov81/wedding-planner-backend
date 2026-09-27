import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common'
import { Webhook } from 'svix'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'

import type { WebhookSignatureVerifier } from '../application/webhook-signature.verifier'
import { FirmaInvalidaError } from '../domain/guest-errors'

/**
 * Verificación Svix (el esquema que usa Resend): HMAC-SHA256 sobre
 * `svix-id.svix-timestamp.cuerpo`, comparado en tiempo constante, con una
 * tolerancia de 5 minutos sobre `svix-timestamp` para que una petición
 * capturada no se pueda reenviar más tarde.
 *
 * DESIGN-GAP: el brief lanza en el constructor si falta `RESEND_WEBHOOK_SECRET`.
 * Aquí el fail-fast vive en el esquema de entorno (`MAIL_DRIVER=resend` exige
 * el secreto, y su forma se valida siempre): lanzar aquí rompería TODO arranque
 * con `MAIL_DRIVER=fake` sin secreto —desarrollo y los e2e de los demás
 * módulos—, donde no existe ningún correo real que casar. Sin secreto el
 * verificador falla CERRADO: rechaza todas las peticiones con 401.
 */
@Injectable()
export class SvixSignatureVerifier implements WebhookSignatureVerifier {
  private readonly webhook: Webhook | null
  private readonly registro = new Logger(SvixSignatureVerifier.name)

  constructor(@Inject(ENV) env: Pick<Env, 'RESEND_WEBHOOK_SECRET'>) {
    const secreto = env.RESEND_WEBHOOK_SECRET
    // Un secreto con forma válida pero base64 corrupto hace lanzar a `new
    // Webhook`: eso SÍ rompe el arranque, que es lo que se quiere.
    this.webhook = secreto === undefined ? null : new Webhook(secreto)
    if (this.webhook === null) {
      this.registro.warn('Sin RESEND_WEBHOOK_SECRET: el webhook de Resend rechazará todo')
    }
  }

  /**
   * Se verifica sobre el cuerpo CRUDO, antes de parsear: la firma cubre los
   * bytes exactos, y `JSON.parse` + `JSON.stringify` los cambia (espacios,
   * orden de claves, escapes). Por eso `main.ts` arranca con `rawBody: true`.
   *
   * El JSON se parsea DESPUÉS y a partir del MISMO texto verificado, nunca del
   * `req.body` que Nest ya parseó: así lo que se valida es exactamente lo que
   * se firmó. (svix 2.x ya no devuelve el payload desde `verify`.)
   */
  verificar(cuerpoCrudo: Buffer, cabeceras: Record<string, string>): unknown {
    if (this.webhook === null) throw new FirmaInvalidaError()

    const texto = cuerpoCrudo.toString('utf8')
    try {
      this.webhook.verify(texto, cabeceras)
    } catch {
      // Cualquier fallo de verificación —firma, cabeceras ausentes, timestamp
      // fuera de tolerancia— es el mismo 401. Se falla CERRADO: si `verify`
      // lanzara por otra causa, tampoco se acepta la petición. Sin detalles en
      // la respuesta: decirle al atacante QUÉ falló le ayuda a afinar.
      throw new FirmaInvalidaError()
    }

    try {
      return JSON.parse(texto) as unknown
    } catch {
      // Firmado pero no es JSON: no es un atacante (la firma casa), es un
      // cuerpo roto del proveedor. 400, no 401.
      throw new BadRequestException('El cuerpo del webhook no es JSON')
    }
  }
}
