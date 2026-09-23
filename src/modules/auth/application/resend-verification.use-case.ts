import { Inject, Injectable, Logger } from '@nestjs/common'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import type { User } from '@/modules/users/domain/user'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import { caducidadVerificacion, generarTokenVerificacion } from '../domain/email-verification'
import {
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepository,
} from './email-verification-token.repository'
import { hashToken } from './token.service'

/**
 * Reenvío del correo de verificación.
 *
 * Devuelve `void` SIEMPRE, y nunca lanza por el estado de la cuenta: cuenta
 * inexistente, cuenta ya verificada y cuenta pendiente son indistinguibles
 * desde fuera. Cualquier dato que saliera de aquí —un booleano, un error, un
 * conteo— acabaría en la respuesta HTTP y convertiría el endpoint en un
 * enumerador de cuentas, que es justo lo que `LoginUseCase` evita pagando
 * Argon2 contra un hash señuelo.
 *
 * FIX (revisión final de rama, hallazgo importante #2): igualar el CÓDIGO y el
 * CUERPO de la respuesta no basta si el TIEMPO hasta esa respuesta difiere.
 * "No existe" y "ya verificada" volvían tras UNA consulta; "pendiente" volvía
 * tras CUATRO (esa misma consulta más caducar tokens vigentes, crear el nuevo
 * y encolar el correo) — un canal de temporización que deja adivinar el
 * estado real de la cuenta con sólo cronometrar la respuesta, exactamente el
 * mismo tipo de fuga que el hash Argon2 señuelo de `LoginUseCase` existe para
 * cerrar en el login.
 *
 * Se elige NO esperar (`await`) ese trabajo: en cuanto se sabe que la cuenta
 * está pendiente de verificar, la petición HTTP contesta —mismo instante,
 * dé igual el estado real— y caducar el token viejo, crear el nuevo y
 * encolar el correo siguen corriendo en segundo plano. La alternativa
 * —esperar siempre un tiempo fijo con un temporizador señuelo, como el hash
 * del login— se descarta aquí porque el login necesita paga CPU real (verificar
 * una contraseña sin filtrar si el hash existe), mientras que este endpoint no
 * tiene nada que "fingir computar": no hay una operación de coste equivalente
 * que deba ejecutarse igual para ambos casos, así que introducir una espera
 * artificial sería más frágil (hay que mantener el retraso sincronizado con
 * el peor caso real) que simplemente no bloquear la respuesta en el trabajo
 * que sólo ocurre en una rama.
 *
 * El `.catch` es obligatorio: una promesa sin `await` y sin manejador de
 * rechazo es un `unhandledRejection` que, según la configuración del proceso
 * Node, puede tumbarlo. Un fallo aquí (cola caída, base de datos momentáneamente
 * inalcanzable) no debe derribar el servidor por un reenvío que de todas formas
 * ya contestó 202 al cliente — se registra y ya está.
 */
@Injectable()
export class ResendVerificationUseCase {
  private readonly logger = new Logger(ResendVerificationUseCase.name)

  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(EMAIL_VERIFICATION_TOKEN_REPOSITORY)
    private readonly tokens: EmailVerificationTokenRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async ejecutar(datos: { email: string }): Promise<void> {
    // Misma normalización que RegisterUseCase: el correo se guardó en
    // minúsculas y sin espacios, así que buscarlo tal cual lo escribió el
    // usuario no encontraría nada y el reenvío fallaría en silencio.
    const email = datos.email.trim().toLowerCase()
    const usuario = await this.usuarios.findByEmail(email)

    if (usuario === null || usuario.emailVerifiedAt !== null) return

    // A propósito SIN `await`: ver el docblock de la clase. El trabajo sigue
    // corriendo tras devolver, y su resultado no puede influir en la
    // respuesta HTTP (que ya es siempre la misma, pase lo que pase aquí).
    void this.emitirEnlaceEnSegundoPlano(usuario).catch((error: unknown) => {
      this.logger.error('Fallo al emitir el enlace de reenvío de verificación', error as Error)
    })
  }

  private async emitirEnlaceEnSegundoPlano(
    usuario: Pick<User, 'id' | 'email' | 'fullName'>,
  ): Promise<void> {
    const ahora = new Date()
    // Un solo enlace vivo por usuario: dos enlaces válidos a la vez alargan sin
    // motivo la ventana en la que un correo viejo filtrado sigue sirviendo.
    await this.tokens.caducarVigentesDe(usuario.id, ahora)

    const tokenEnClaro = generarTokenVerificacion()
    const { id: tokenId } = await this.tokens.crear({
      userId: usuario.id,
      tokenHash: hashToken(tokenEnClaro),
      expiresAt: caducidadVerificacion(this.env.EMAIL_VERIFICATION_TTL_HOURS, ahora),
    })

    await this.cola.enqueue(
      'email',
      'send-verification-email',
      {
        userId: usuario.id,
        tokenId,
        email: usuario.email,
        fullName: usuario.fullName,
        token: tokenEnClaro,
      },
      // removeOnComplete obligatorio: el payload lleva el token en claro.
      { jobId: `verify-email-${tokenId}`, removeOnComplete: true },
    )
  }
}
