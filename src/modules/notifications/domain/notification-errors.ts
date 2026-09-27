import { NotFoundError } from '@/shared/domain'

/**
 * La notificación no existe, es de otro evento o es de OTRO usuario: los tres
 * casos responden igual, para que un id ajeno no confirme que existe.
 */
export class NotificacionNoEncontradaError extends NotFoundError {
  constructor() {
    super('La notificación no existe', 'NOTIFICATION_NOT_FOUND')
  }
}
