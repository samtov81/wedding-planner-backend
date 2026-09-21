import { Global, Module } from '@nestjs/common'

import { UNIDAD_DE_TRABAJO } from './application/unidad-de-trabajo'
import { PrismaService } from './prisma.service'
import { PrismaUnidadDeTrabajo } from './transaccion'

@Global()
@Module({
  providers: [PrismaService, { provide: UNIDAD_DE_TRABAJO, useClass: PrismaUnidadDeTrabajo }],
  exports: [PrismaService, UNIDAD_DE_TRABAJO],
})
export class DatabaseModule {}
