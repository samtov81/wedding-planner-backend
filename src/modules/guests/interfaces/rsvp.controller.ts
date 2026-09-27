import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common'

import { LIMITADOR_RSVP, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import { GetRsvpUseCase, type VistaPublicaRsvp } from '../application/get-rsvp.use-case'
import { SubmitRsvpUseCase } from '../application/submit-rsvp.use-case'
import { InvitacionNoValidaError } from '../domain/guest-errors'
import { responderRsvpSchema, tokenRsvpSchema } from './rsvp.dto'

/**
 * RSVP público: quien abre el enlace del correo y contesta.
 *
 * SIN `JwtAuthGuard` NI `EventAccessGuard`, A PROPÓSITO. El invitado no tiene
 * cuenta: la credencial de esta ruta ES el token de la URL. Los guards de este
 * código se ponen por controlador/método, así que este controlador nace sin
 * ninguno — y así debe quedarse. Añadirle un guard de usuario no lo "protege":
 * deja a todos los invitados sin poder contestar.
 *
 * Lo que sí lleva es su propio límite de ritmo, en Redis para que valga entre
 * instancias. Son los dos únicos endpoints sin sesión que aceptan un secreto
 * adivinable en teoría: un token de 32 bytes no se acierta por fuerza bruta,
 * pero el límite corta el sondeo antes de que genere carga.
 *
 * El límite propio se SUMA al global de 120/min por IP que lleva toda la API
 * (`APP_GUARD`, ruling C22); ver `limitadores.ts`.
 *
 * DESIGN-GAP: el brief pone `@SkipThrottle(false)` y `@Throttle({ rsvp })`.
 * Aquí es `@LimiteDeRuta(LIMITADOR_RSVP, ...)`: el limitador `rsvp` se salta en
 * toda ruta que no lo pida con esa marca, para que su 5/min no caiga sobre el
 * resto de la API. `@SkipThrottle(false)` no cambiaría nada: no hay nada que
 * saltar.
 *
 * El token viaja en el path. Nunca se registra: no hay log de peticiones, el
 * `DomainExceptionFilter` lo tacha de la URL que registra en un 500, y ningún
 * mensaje de error lo incluye.
 */
@Controller('rsvp')
export class RsvpController {
  constructor(
    private readonly obtenerRsvp: GetRsvpUseCase,
    private readonly responderRsvp: SubmitRsvpUseCase,
  ) {}

  @Get(':token')
  @LimiteDeRuta(LIMITADOR_RSVP, { limit: 20, ttl: 60_000 })
  async obtener(@Param('token') token: string): Promise<VistaPublicaRsvp> {
    return await this.obtenerRsvp.ejecutar(tokenConForma(token))
  }

  /**
   * El cuerpo se valida ANTES que el token: su 400 depende sólo del cuerpo, así
   * que no dice nada del token. 204 al aceptar: no hay nada que devolver que el
   * invitado no acabe de enviar.
   */
  @Post(':token')
  @LimiteDeRuta(LIMITADOR_RSVP, { limit: 5, ttl: 60_000 })
  @HttpCode(204)
  async responder(@Param('token') token: string, @Body() body: unknown): Promise<void> {
    const respuesta = validarCon(responderRsvpSchema, body)
    await this.responderRsvp.ejecutar(tokenConForma(token), respuesta)
  }
}

/**
 * Un token mal formado es un token inexistente: mismo error, mismo status, mismo
 * mensaje. Por eso no pasa por `validarCon`, cuyo 400 lo distinguiría.
 */
function tokenConForma(token: string): string {
  const resultado = tokenRsvpSchema.safeParse(token)
  if (!resultado.success) throw new InvitacionNoValidaError()
  return resultado.data
}
