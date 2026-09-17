import { randomUUID } from 'node:crypto'

import type { UserRepository } from '../application/user.repository'
import { normalizarEmail, type User, type UserConHash } from '../domain/user'
import { EmailYaRegistradoError } from '../domain/user-errors'

/**
 * Repositorio de usuarios en memoria para tests. Se comporta idénticamente
 * a `PrismaUserRepository`: normaliza emails, rechaza duplicados, filtra
 * el passwordHash en findById. Usado por Tarea 8 (autenticación) para
 * escribir tests sin dependencia en Prisma.
 */
export class UserRepositoryEnMemoria implements UserRepository {
  private usuarios: UserConHash[] = []

  constructor(usuariosIniciales: UserConHash[] = []) {
    this.usuarios = usuariosIniciales.map((u) => ({ ...u }))
  }

  async findByEmail(email: string): Promise<UserConHash | null> {
    const normalizado = normalizarEmail(email)
    const usuario = this.usuarios.find((u) => u.email === normalizado)
    return await Promise.resolve(usuario ? { ...usuario } : null)
  }

  async findById(id: string): Promise<User | null> {
    const usuario = this.usuarios.find((u) => u.id === id)
    if (!usuario) return await Promise.resolve(null)

    const { passwordHash: _oculto, ...publico } = usuario
    return await Promise.resolve(publico)
  }

  async create(datos: { email: string; passwordHash: string; fullName: string }): Promise<User> {
    const emailNormalizado = normalizarEmail(datos.email)

    // Rechazar si el email ya existe (como el real)
    if (this.usuarios.some((u) => u.email === emailNormalizado)) {
      throw new EmailYaRegistradoError()
    }

    const usuario: UserConHash = {
      id: randomUUID(),
      email: emailNormalizado,
      passwordHash: datos.passwordHash,
      fullName: datos.fullName,
      systemRole: 'USER',
      emailVerifiedAt: null,
    }

    this.usuarios.push({ ...usuario })

    const { passwordHash: _oculto, ...publico } = usuario
    return await Promise.resolve(publico)
  }

  async marcarEmailVerificado(id: string): Promise<void> {
    const usuario = this.usuarios.find((u) => u.id === id)
    if (usuario) {
      usuario.emailVerifiedAt = new Date()
    }
    await Promise.resolve()
  }
}
