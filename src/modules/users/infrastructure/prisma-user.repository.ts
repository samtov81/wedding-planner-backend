import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
import { PrismaService } from '@/modules/database/prisma.service'

import type { UserRepository } from '../application/user.repository'
import { normalizarEmail, type User, type UserConHash } from '../domain/user'
import { EmailYaRegistradoError } from '../domain/user-errors'

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<UserConHash | null> {
    const fila = await this.prisma.user.findUnique({ where: { email: normalizarEmail(email) } })
    return fila === null ? null : { ...fila }
  }

  async findById(id: string): Promise<User | null> {
    const fila = await this.prisma.user.findUnique({ where: { id } })
    if (fila === null) return null

    const { passwordHash: _oculto, ...publico } = fila
    return publico
  }

  async create(datos: { email: string; passwordHash: string; fullName: string }): Promise<User> {
    try {
      const fila = await this.prisma.user.create({
        data: { ...datos, email: normalizarEmail(datos.email) },
      })
      const { passwordHash: _oculto, ...publico } = fila
      return publico
    } catch (error) {
      // P2002 = violación de índice único. Se traduce a un error de DOMINIO
      // aquí, en la frontera: dejarlo subir obligaría a los casos de uso a
      // conocer los códigos de Prisma, que es justo lo que el puerto evita.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new EmailYaRegistradoError()
      }
      throw error
    }
  }

  async marcarEmailVerificado(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } })
  }

  async actualizarPassword(id: string, passwordHash: string): Promise<void> {
    // `clienteDe`: corre dentro de la unidad de trabajo de ResetPasswordUseCase.
    const db = clienteDe(this.prisma)
    await db.user.update({ where: { id }, data: { passwordHash } })
    // Condicional en el WHERE: no se pisa la fecha de una verificación previa.
    await db.user.updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } })
  }
}
