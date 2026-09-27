import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/modules/database/prisma.service'
import { clienteDe } from '@/modules/database/transaccion'

import type {
  PasswordResetTokenRepository,
  TokenResetConsumido,
} from '../application/password-reset-token.repository'

/**
 * Escribe SIEMPRE con `clienteDe(this.prisma)`: `ResetPasswordUseCase` consume
 * el token dentro de la misma unidad de trabajo que cambia la contraseña y
 * revoca las sesiones (ver el contrato en `UnidadDeTrabajo`).
 */
@Injectable()
export class PrismaPasswordResetTokenRepository implements PasswordResetTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    return await clienteDe(this.prisma).passwordResetToken.create({ data: datos, select: { id: true } })
  }

  async caducarVigentesDe(userId: string, ahora: Date): Promise<void> {
    await clienteDe(this.prisma).passwordResetToken.updateMany({
      where: { userId, status: 'PENDING', expiresAt: { gt: ahora } },
      data: { expiresAt: ahora },
    })
  }

  async consumirPorHash(tokenHash: string, ahora: Date): Promise<TokenResetConsumido | null> {
    const db = clienteDe(this.prisma)
    const fila = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    })
    if (fila === null) return null

    // El CAS es el `updateMany` con el estado y la caducidad en el WHERE: de
    // dos peticiones concurrentes con el mismo token sólo una ve count === 1.
    const { count } = await db.passwordResetToken.updateMany({
      where: { id: fila.id, status: 'PENDING', expiresAt: { gt: ahora } },
      data: { status: 'CONSUMED', consumedAt: ahora },
    })
    return count === 1 ? { userId: fila.userId, tokenId: fila.id } : null
  }
}
