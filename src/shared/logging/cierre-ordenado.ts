import { Injectable, type OnApplicationShutdown } from '@nestjs/common'
import { Logger } from 'nestjs-pino'

/** Lo que el smoke busca en el stdout del proceso. Si lo cambias, cámbialo allí. */
export const CIERRE_ORDENADO = 'Cierre ordenado completado'

/**
 * Deja constancia de que el cierre ordenado ocurrió DE VERDAD.
 *
 * Sin esto, el smoke de SIGTERM no probaba nada: un proceso de Node sin
 * `enableShutdownHooks()` también muere por SIGTERM —lo mata el manejador por
 * defecto, al instante y sin cerrar Prisma, Redis ni los workers—, así que
 * "sale por la señal" se cumplía igual con los hooks apagados. Este hook sólo
 * lo ejecuta Nest cuando los hooks están puestos, y su línea en stdout es la
 * única señal observable desde fuera de que el cierre fue ordenado.
 *
 * Va el ÚLTIMO del cierre por ser el proveedor más externo (Nest destruye en
 * orden inverso al de construcción, y éste no lo inyecta nadie).
 */
@Injectable()
export class CierreOrdenado implements OnApplicationShutdown {
  constructor(private readonly registro: Logger) {}

  onApplicationShutdown(senal?: string): void {
    this.registro.log(`${CIERRE_ORDENADO} (${senal ?? 'sin señal'})`)
  }
}
