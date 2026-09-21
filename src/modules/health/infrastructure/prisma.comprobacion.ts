import type { PrismaService } from '@/modules/database/prisma.service'

import { aTiempo, type Comprobacion } from '../application/comprobacion.port'

export class PrismaComprobacion implements Comprobacion {
  readonly nombre = 'db'

  constructor(private readonly prisma: PrismaService) {}

  async comprobar(): Promise<boolean> {
    return await aTiempo(this.prisma.$queryRaw`SELECT 1`)
  }
}
