import type { IncomingHttpHeaders } from 'node:http'

import { Controller, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common'

import { LIMITADOR_WEBHOOK, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import { HandleDeliveryEventUseCase } from '../application/handle-delivery-event.use-case'
import {
  WEBHOOK_SIGNATURE_VERIFIER,
  type WebhookSignatureVerifier,
} from '../application/webhook-signature.verifier'
import { FirmaInvalidaError } from '../domain/guest-errors'
import { eventoResendSchema } from './resend-webhook.dto'

/**
 * Lo que este controlador lee de la petición. `rawBody` lo pone Nest porque
 * `main.ts` arranca con `rawBody: true`; sólo existe si el cuerpo pasó por el
 * parser de JSON (o urlencoded).
 */
interface PeticionWebhook {
  rawBody?: Buffer
  headers: IncomingHttpHeaders
}

/**
 * Webhook de eventos de entrega de Resend.
 *
 * SIN `JwtAuthGuard` NI `EventAccessGuard`, A PROPÓSITO. Quien llama es Resend,
 * no un usuario: no hay JWT que presentar. Los guards de este código se ponen
 * por controlador/método, así que este controlador nace sin ninguno — y así
 * debe quedarse. La autenticación de esta ruta ES la firma Svix, verificada
 * antes de mirar el cuerpo. Añadir aquí un guard de usuario no la "protege":
 * la rompe (todo webhook sería 401 y Resend acabaría desactivando el endpoint).
 */
@Controller('webhooks')
export class ResendWebhookController {
  private readonly registro = new Logger(ResendWebhookController.name)

  constructor(
    @Inject(WEBHOOK_SIGNATURE_VERIFIER) private readonly verificador: WebhookSignatureVerifier,
    private readonly manejarEvento: HandleDeliveryEventUseCase,
  ) {}

  /**
   * Orden no negociable: firma → forma → escritura. Nada del cuerpo se usa, ni
   * se toca la base de datos, antes de que la firma case.
   *
   * 204 también cuando el evento se ignora (tipo que no nos importa, correo
   * que no es una invitación, estado que ya estaba más adelante): cualquier
   * respuesta no-2xx hace que Resend reintente, y ninguno de esos casos se
   * arregla reintentando. Por lo mismo, reentregar un evento da 204 y el mismo
   * estado final.
   */
  @Post('resend')
  @HttpCode(204)
  @LimiteDeRuta(LIMITADOR_WEBHOOK, { limit: 1200, ttl: 60_000 })
  async recibir(@Req() peticion: PeticionWebhook): Promise<void> {
    const payload = this.verificarFirma(peticion)
    const evento = validarCon(eventoResendSchema, payload)

    // Evento que no es de un correo (`contact.*`, `domain.*`): nada que casar.
    if (evento.data.email_id === undefined) return

    await this.manejarEvento.ejecutar({ type: evento.type, messageId: evento.data.email_id })
  }

  private verificarFirma(peticion: PeticionWebhook): unknown {
    try {
      // Sin cuerpo crudo (p. ej. un `Content-Type` que ningún parser acepta)
      // no hay bytes sobre los que verificar: se rechaza igual que una firma
      // mala, sin intentar reconstruirlos desde `req.body`.
      if (!Buffer.isBuffer(peticion.rawBody)) throw new FirmaInvalidaError()
      return this.verificador.verificar(peticion.rawBody, cabecerasDeFirma(peticion.headers))
    } catch (error) {
      // Nunca se registra el cuerpo, las cabeceras de firma ni el secreto. Un
      // chorro de estos avisos tras rotar el secreto delata la configuración.
      if (error instanceof FirmaInvalidaError) {
        this.registro.warn('Webhook de Resend rechazado: firma ausente, inválida o caducada')
      }
      throw error
    }
  }
}

/**
 * Sólo las tres cabeceras que firma Svix, y sólo si llegan UNA vez: una
 * cabecera repetida llega como array y se descarta (la verificación fallará
 * por cabecera ausente) en vez de elegir una de las copias.
 */
function cabecerasDeFirma(cabeceras: IncomingHttpHeaders): Record<string, string> {
  const id = cabeceras['svix-id']
  const timestamp = cabeceras['svix-timestamp']
  const firma = cabeceras['svix-signature']
  return {
    ...(typeof id === 'string' ? { 'svix-id': id } : {}),
    ...(typeof timestamp === 'string' ? { 'svix-timestamp': timestamp } : {}),
    ...(typeof firma === 'string' ? { 'svix-signature': firma } : {}),
  }
}
