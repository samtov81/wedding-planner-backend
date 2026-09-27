import { Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { clienteDe } from '@/modules/database/transaccion'
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

  async rotar(datos: { sesionARevocar: string; nueva: DatosNuevaSesion }): Promise<boolean> {
    // Revocar y crear, o ninguna de las dos: si el insert de la hija fallase
    // después de una revocación ya confirmada, el usuario se quedaría sin
    // sesión y sin ninguna ruta de recuperación salvo volver a hacer login.
    return await this.prisma.$transaction(async (tx) => {
      const sesion = await tx.session.findUnique({
        where: { id: datos.sesionARevocar },
        select: { familyId: true },
      })
      if (sesion === null) return false
      await this.bloquearFamilia(tx, sesion.familyId)

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
    await this.prisma.$transaction(async (tx) => {
      await this.bloquearFamilia(tx, familyId)
      await tx.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    })
  }

  async buscarSesionVivaDeFamilia(familyId: string): Promise<SesionPersistida | null> {
    const fila = await this.prisma.session.findFirst({ where: { familyId, revokedAt: null } })
    if (fila === null) return null

    return {
      id: fila.id,
      userId: fila.userId,
      familyId: fila.familyId,
      expiresAt: fila.expiresAt,
      revokedAt: fila.revokedAt,
    }
  }

  async revocarTodasDeUsuario(userId: string): Promise<void> {
    const revocar = async (tx: Prisma.TransactionClient): Promise<void> => {
      // Mismo cerrojo que `rotar`, familia a familia y en orden estable (evita
      // interbloqueos entre dos revocaciones concurrentes). Una rotación que
      // tenía el cerrojo al leer esta lista ya aparece aquí porque su sesión
      // madre seguía viva; el `updateMany` de abajo corre tras su COMMIT y ve
      // a la hija.
      const familias = await tx.session.findMany({
        where: { userId, revokedAt: null },
        select: { familyId: true },
        distinct: ['familyId'],
        orderBy: { familyId: 'asc' },
      })
      for (const { familyId } of familias) await this.bloquearFamilia(tx, familyId)

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }

    // Dentro de una unidad de trabajo se une a ella; fuera, abre la suya: el
    // cerrojo consultivo sólo existe dentro de una transacción.
    const actual = clienteDe(this.prisma)
    if (actual !== this.prisma) return await revocar(actual)
    await this.prisma.$transaction(revocar)
  }

  /**
   * Serializa `rotar` y `revocarFamilia` de UNA familia con un cerrojo
   * consultivo que se suelta solo al terminar la transacción.
   *
   * Sin él, en READ COMMITTED, el `UPDATE ... WHERE familyId` de la revocación
   * toma su instantánea mientras una rotación concurrente aún no ha hecho
   * COMMIT: espera al cerrojo de fila de la hermana, la revoca al reevaluarla,
   * pero NO ve a la hija que esa rotación inserta, que queda viva en una
   * familia revocada — justo el token que la detección de reuso quería matar.
   * Con el cerrojo, la segunda transacción empieza después del COMMIT de la
   * primera: o la rotación ve la hermana ya revocada y no crea hija, o la
   * revocación ve a la hija y la revoca.
   *
   * `hashtext` reduce el UUID a la clave entera que pide el cerrojo; una
   * colisión entre dos familias sólo las serializa de más, nunca de menos.
   */
  private async bloquearFamilia(tx: Prisma.TransactionClient, familyId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${familyId}))`
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
