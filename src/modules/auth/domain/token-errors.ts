import { UnauthorizedError } from '@/shared/domain'

/**
 * 401, no 403, contra lo que decía el `Produces` del encargo. La regla global
 * reserva 403 para "tiene acceso al evento pero no permiso para ESA
 * operación": un refresh rechazado o reutilizado no es un fallo de permiso
 * sobre un recurso, es un fallo de identidad. Con 403, el mismo subsistema
 * respondía 401 a una contraseña mala y 403 a un refresh muerto, y un frontend
 * que dispara "re-autenticar" ante un 401 nunca lo haría al morir la cookie.
 * Los `code` NO cambian: siguen siendo estables y distintos entre sí, que es
 * como el cliente distingue "robado" de "caducado".
 */
export class RefreshInvalidoError extends UnauthorizedError {
  constructor() {
    super('La sesión no es válida', 'REFRESH_INVALID')
  }
}

export class RefreshReutilizadoError extends UnauthorizedError {
  constructor() {
    super('La sesión se ha cerrado por seguridad', 'REFRESH_REUSED')
  }
}
