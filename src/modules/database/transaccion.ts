import { AsyncLocalStorage } from 'node:async_hooks'

import { Injectable } from '@nestjs/common'
import type { Prisma, PrismaClient } from '@prisma/client'

import type { UnidadDeTrabajo } from './application/unidad-de-trabajo'
import { PrismaService } from './prisma.service'

/**
 * La transacción en curso, atada al contexto asíncrono de quien la abrió. Dos
 * peticiones concurrentes tienen contextos distintos, así que cada una ve la
 * suya (o ninguna); no es estado compartido entre peticiones.
 */
const transaccionEnCurso = new AsyncLocalStorage<Prisma.TransactionClient>()

/**
 * El cliente con el que un repositorio debe escribir: el de la transacción en
 * curso si la hay, o el suyo propio si no. Ver el contrato en
 * `UnidadDeTrabajo`.
 *
 * Recibe el `PrismaClient` en vez de leer el `PrismaService` inyectado para que
 * los tests de repositorio que construyen el adaptador con un `PrismaClient`
 * pelado sigan funcionando igual.
 */
export function clienteDe(prisma: PrismaClient): Prisma.TransactionClient {
  return transaccionEnCurso.getStore() ?? prisma
}

/**
 * Para un repositorio cuya escritura es multi-tabla y necesita su propia
 * transacción (`aceptarInvitacion`, `revocarMembresia`): si ya hay una unidad de
 * trabajo en curso se UNE a ella, y si no abre una (y la ata al contexto, de modo
 * que un `clienteDe` anidado la vea).
 *
 * Alternativa descartada: `this.prisma.$transaction(...)` a secas. Dentro de una
 * unidad de trabajo abriría una SEGUNDA transacción por otra conexión: lo que
 * escribe se confirmaría aunque la exterior se deshiciera, y no vería las
 * escrituras aún sin confirmar de ésta.
 */
export async function enTransaccion<T>(
  prisma: PrismaClient,
  trabajo: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const enCurso = transaccionEnCurso.getStore()
  if (enCurso !== undefined) return await trabajo(enCurso)
  return await prisma.$transaction((tx) => transaccionEnCurso.run(tx, () => trabajo(tx)))
}

@Injectable()
export class PrismaUnidadDeTrabajo implements UnidadDeTrabajo {
  constructor(private readonly prisma: PrismaService) {}

  async ejecutar<T>(trabajo: () => Promise<T>): Promise<T> {
    if (transaccionEnCurso.getStore() !== undefined) return await trabajo()
    return await this.prisma.$transaction((tx) => transaccionEnCurso.run(tx, trabajo))
  }
}
