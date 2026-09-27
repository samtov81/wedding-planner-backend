import { BadRequestException } from '@nestjs/common'
import { ZodError } from 'zod'

/**
 * Esquema mínimo que `validarCon` necesita. Es a propósito más estrecho que
 * `ZodType`: así el borde no queda atado a una versión concreta de Zod, y un
 * test puede pasar un doble sin construir un esquema real.
 */
export interface EsquemaValidable<T> {
  parse: (valor: unknown) => T
}

/**
 * ÚNICA traducción de "el cuerpo no cumple el esquema" a respuesta HTTP. Vive
 * aquí y no en cada controlador porque la forma del 400 es un contrato con el
 * frontend: repartida por los controladores, cambiarla obliga a tocarlos todos
 * y nada avisa si te dejas uno.
 *
 * Los mensajes de todos los `issues` se concatenan con `; ` en vez de devolver
 * sólo el primero: quien envía un formulario entero quiere saber qué falla en
 * los cinco campos, no descubrirlo de uno en uno.
 *
 * Lo que no es un `ZodError` se relanza intacto: un fallo dentro de un
 * `.refine()` es un error del servidor, no una petición mal formada, y
 * disfrazarlo de 400 haría que el cliente reintentara con otros datos para
 * siempre.
 */
export function validarCon<T>(esquema: EsquemaValidable<T>, valor: unknown): T {
  try {
    return esquema.parse(valor)
  } catch (error) {
    if (error instanceof ZodError) {
      throw new BadRequestException(error.issues.map((i) => i.message).join('; '))
    }
    throw error
  }
}
