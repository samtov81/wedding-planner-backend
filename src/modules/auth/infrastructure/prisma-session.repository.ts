import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'

import type { SesionPersistida, SessionRepository } from '../application/session.repository'

@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async crear(datos: {
    userId: string
    tokenHash: string
    familyId: string
    expiresAt: Date
  }): Promise<void> {
    await this.prisma.session.create({ data: datos })
  }

  async buscarPorHash(tokenHash: string): Promise<SesionPersistida | null> {
    const fila = await this.prisma.session.findUnique({ where: { tokenHash } })
    if (fila === null) return null

    return {
      id: fila.id,
      userId: fila.userId,
      familyId: fila.familyId,
      expiresAt: fila.expiresAt,
      revokedAt: fila.revokedAt,
    }
  }

  async revocar(id: string): Promise<void> {
    // `updateMany` en vez de `update`: revocar dos veces una sesión ya
    // revocada (o una que ya no existe) no puede ser un error de este
    // repositorio, es un no-op observable por el caso de uso vía su lectura.
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  async revocarFamilia(familyId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
}
