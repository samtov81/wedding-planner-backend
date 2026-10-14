/**
 * Forma de un id de Postgres `uuid`. Vive aparte porque la usan el guard (para
 * `:eventId`) y las rutas de miembros (para `:membershipId` y para el
 * `:eventId` de aceptar/rechazar, que no pasan por el guard). Un id con otra
 * forma llegaría a Prisma como P2023 → 500, y un 500 donde el resto ve 404
 * distingue "id con forma válida" de "id inventado": se responde el mismo 404.
 *
 * Una regex y no `z.uuid()`: es la que el guard ya usaba, y dos validadores
 * distintos para el mismo parámetro acabarían discrepando en algún borde
 * (`z.uuid()` exige versión y variante RFC 9562; Postgres no).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function esUuid(valor: string | undefined): valor is string {
  return valor !== undefined && UUID.test(valor)
}
