import { Injectable } from '@nestjs/common'
import { PrismaService } from '@/modules/database/prisma.service'
import type {
  ConsumoToken,
  EmailVerificationTokenRepository,
} from '../application/email-verification-token.repository'

@Injectable()
export class PrismaEmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async crear(datos: { userId: string; tokenHash: string; expiresAt: Date }): Promise<{ id: string }> {
    const creado = await this.prisma.emailVerificationToken.create({
      data: {
        userId: datos.userId,
        tokenHash: datos.tokenHash,
        expiresAt: datos.expiresAt,
      },
      select: { id: true },
    })
    return creado
  }

  async caducarVigentesDe(userId: string, ahora: Date): Promise<void> {
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId, status: 'PENDING', expiresAt: { gt: ahora } },
      data: { expiresAt: ahora },
    })
  }

  async consumirPorHash(tokenHash: string, ahora: Date): Promise<ConsumoToken> {
    // Intenta consumir en una operación atómica: sólo actualiza si el token
    // está PENDING y aún no ha caducado.
    const consumido = await this.prisma.emailVerificationToken.updateMany({
      where: {
        tokenHash,
        status: 'PENDING',
        expiresAt: { gt: ahora },
      },
      data: {
        status: 'CONSUMED',
        consumedAt: ahora,
      },
    })

    if (consumido.count > 0) {
      // Se consumió. Obtener el userId para devolver.
      const token = await this.prisma.emailVerificationToken.findUnique({
        where: { tokenHash },
        select: { userId: true },
      })
      return { resultado: 'CONSUMIDO', userId: token!.userId }
    }

    // No se consumió (0 filas actualizadas). ¿Está ya consumido o no existe/caducado?
    const existente = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { status: true, expiresAt: true, userId: true },
    })

    if (existente === null) return { resultado: 'NO_ENCONTRADO_O_CADUCADO' }
    if (existente.status === 'CONSUMED') return { resultado: 'YA_CONSUMIDO', userId: existente.userId }
    return { resultado: 'NO_ENCONTRADO_O_CADUCADO' }
  }
}
