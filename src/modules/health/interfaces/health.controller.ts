import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'

import { LIMITADOR_GLOBAL, LIMITADOR_LOGIN, LIMITADOR_RSVP } from '@/shared/http/limitadores'

import { COMPROBACIONES, type Comprobacion } from '../application/comprobacion.port'

type Checks = Record<Comprobacion['nombre'], boolean>

/**
 * Sin límite de ritmo, a propósito: las sondas del orquestador llegan desde la
 * misma IP y a ritmo fijo, y el limitador `global` (120/min por IP) acabaría
 * contestando 429 a la liveness — el orquestador lo lee como "muerto" y mata un
 * pod sano. `SkipThrottle()` a secas sólo salta el limitador `default`, que
 * aquí no existe: hay que nombrarlos todos.
 */
@SkipThrottle({ [LIMITADOR_GLOBAL]: true, [LIMITADOR_RSVP]: true, [LIMITADOR_LOGIN]: true })
@Controller('health')
export class HealthController {
  constructor(@Inject(COMPROBACIONES) private readonly comprobaciones: Comprobacion[]) {}

  /** Liveness: ¿el proceso está vivo? No toca dependencias a propósito. */
  @Get()
  vivo(): { status: 'ok' } {
    return { status: 'ok' }
  }

  /**
   * Readiness: ¿puede atender tráfico? Aquí SÍ se comprueban las dependencias.
   * La distinción importa: si liveness fallara con la base de datos caída, el
   * orquestador reiniciaría el proceso en bucle durante el incidente.
   */
  @Get('ready')
  async listo(): Promise<{ status: 'ok'; checks: Checks }> {
    const resultados = await Promise.all(
      this.comprobaciones.map(async (c) => [c.nombre, await c.comprobar()] as const),
    )
    const checks = Object.fromEntries(resultados) as Checks

    if (resultados.some(([, ok]) => !ok)) throw new ServiceUnavailableException({ checks })
    return { status: 'ok', checks }
  }
}
