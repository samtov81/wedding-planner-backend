import { ForbiddenError } from '@/shared/domain'

export class RefreshInvalidoError extends ForbiddenError {
  constructor() {
    super('La sesión no es válida', 'REFRESH_INVALID')
  }
}

export class RefreshReutilizadoError extends ForbiddenError {
  constructor() {
    super('La sesión se ha cerrado por seguridad', 'REFRESH_REUSED')
  }
}
