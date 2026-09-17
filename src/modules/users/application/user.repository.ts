import type { User, UserConHash } from '../domain/user'

export interface UserRepository {
  findByEmail(email: string): Promise<UserConHash | null>
  findById(id: string): Promise<User | null>
  create(datos: { email: string; passwordHash: string; fullName: string }): Promise<User>
  marcarEmailVerificado(id: string): Promise<void>
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY')
