import { ForbiddenError, UnauthorizedError } from '@/shared/domain'

/**
 * Mismo error para "el email no existe" y "la contraseña es incorrecta".
 * Distinguirlos permite enumerar cuentas: un atacante probaría emails y
 * miraría si la respuesta cambia. Aquí no cambia ni el código, ni el mensaje,
 * ni el tiempo de respuesta (ver `LoginUseCase`, que verifica contra un hash
 * señuelo cuando el usuario no existe).
 */
export class CredencialesInvalidasError extends UnauthorizedError {
  constructor() {
    super('Email o contraseña incorrectos', 'INVALID_CREDENTIALS')
  }
}

/**
 * 403 y no 401: las credenciales ERAN correctas, lo que falta es un requisito
 * de la cuenta. Un 401 haría que el frontend intentara refrescar la sesión.
 */
export class EmailNoVerificadoError extends ForbiddenError {
  constructor() {
    super('Verifica tu correo antes de iniciar sesión', 'EMAIL_NOT_VERIFIED')
  }
}
