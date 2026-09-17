import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'

import type {
  DatosNuevaSesion,
  SesionPersistida,
  SessionRepository,
} from '../application/session.repository'

@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async crear(datos: DatosNuevaSesion): Promise<void> {
    await this.prisma.session.create({ data: this.aFila(datos) })
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

  async revocar(id: string): Promise<boolean> {
    // `updateMany` con `revokedAt: null` en el WHERE es un compare-and-swap:
    // la base de datos decide quién gana. `count === 1` significa "esta
    // llamada fue la que revocó"; `0`, que llegó tarde. Devolverlo (en vez de
    // `void`) es lo que permite al caso de uso detectar el reuso por carrera.
    const { count } = await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return count === 1
  }

  async rotar(datos: { sesionARevocar: string; nueva: DatosNuevaSesion }): Promise<boolean> {
    // Revocar y crear, o ninguna de las dos: si el insert de la hija fallase
    // después de una revocación ya confirmada, el usuario se quedaría sin
    // sesión y sin ninguna ruta de recuperación salvo volver a hacer login.
    return await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id: datos.sesionARevocar, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (count !== 1) return false

      await tx.session.create({ data: this.aFila(datos.nueva) })
      return true
    })
  }

  async revocarFamilia(familyId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  private aFila(datos: DatosNuevaSesion): {
    userId: string
    tokenHash: string
    familyId: string
    expiresAt: Date
    ip: string | null
    userAgent: string | null
  } {
    return {
      userId: datos.userId,
      tokenHash: datos.tokenHash,
      familyId: datos.familyId,
      expiresAt: datos.expiresAt,
      ip: datos.ip ?? null,
      userAgent: datos.userAgent ?? null,
    }
  }
}
