import { ConflictError, NotFoundError } from '@/shared/domain'

export class EmailYaRegistradoError extends ConflictError {
  constructor() {
    super('Ya existe una cuenta con ese email', 'EMAIL_ALREADY_REGISTERED')
  }
}

export class UsuarioNoEncontradoError extends NotFoundError {
  constructor() {
    super('El usuario no existe', 'USER_NOT_FOUND')
  }
}
