/**
 * Qué NO puede llegar nunca a un log. Un único sitio para las dos vías por las
 * que sale una petición al log: `DomainExceptionFilter` (el 500) y pino-http
 * (la línea de cada petición). Dos copias de la regex acabarían divergiendo, y
 * la que se quedara atrás filtraría el token.
 */

/**
 * Segmentos de ruta que SON una credencial: el token del RSVP público
 * (`/rsvp/:token`) es lo único que hace falta para responder por alguien.
 * La URL se registra para poder depurar; el token, nunca.
 *
 * `i` porque Express casa las rutas sin distinguir mayúsculas: `/RSVP/<token>`
 * llega al mismo controlador y tiene que tacharse igual. Sin anclar al
 * principio por el mismo motivo (`//rsvp/<token>` también casa).
 */
const TOKEN_EN_RUTA = /(\/rsvp\/)[^/?#]+/gi

export const CENSURA = '[REDACTADO]'

export function urlParaRegistro(url: string | undefined): string | undefined {
  return url?.replace(TOKEN_EN_RUTA, `$1${CENSURA}`)
}

/**
 * Rutas (sintaxis de `redact` de pino) de todo lo que es un secreto en una
 * línea de log. No es una lista de cortesía: un log con el header
 * Authorization convierte el sistema de logs en un almacén de credenciales, y
 * los logs se retienen, se exportan y se comparten con más gente que la base
 * de datos.
 *
 * - `authorization`: el access token.
 * - `cookie` / `set-cookie`: el refresh token viaja en cookie en ambos sentidos.
 * - `svix-signature` / `webhook-signature`: la firma del webhook de Resend. No
 *   da acceso por sí sola, pero junto al cuerpo permite repetir la entrega
 *   dentro de la ventana de tolerancia de Svix.
 */
export const RUTAS_REDACTADAS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["svix-signature"]',
  'req.headers["webhook-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
  '*.refreshToken',
]
