import type { User, UserConHash } from '../domain/user'

export interface UserRepository {
  findByEmail(email: string): Promise<UserConHash | null>
  findById(id: string): Promise<User | null>
  create(datos: { email: string; passwordHash: string; fullName: string }): Promise<User>
  marcarEmailVerificado(id: string): Promise<void>
  /**
   * Cambia el hash de la contraseña. Marca además el email como verificado si
   * no lo estaba: sólo se llama tras consumir un enlace enviado a ese buzón,
   * que es prueba de control del mismo.
   */
  actualizarPassword(id: string, passwordHash: string): Promise<void>
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY')
