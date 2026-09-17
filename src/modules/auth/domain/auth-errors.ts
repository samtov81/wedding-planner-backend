import { UnauthorizedError } from '@/shared/domain'

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
