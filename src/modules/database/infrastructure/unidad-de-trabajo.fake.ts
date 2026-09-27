import { AsyncLocalStorage } from 'node:async_hooks'

import type { UnidadDeTrabajo } from '../application/unidad-de-trabajo'

/**
 * Doble en memoria del puerto (ruling H1). Ejecuta el trabajo y registra que
 * lo hizo DENTRO de una unidad de trabajo, para que un test pueda comprobar
 * qué escrituras quedaron dentro y cuáles fuera. Usa el mismo mecanismo que el
 * adaptador real (contexto asíncrono), así que dos `ejecutar` CONCURRENTES son
 * dos unidades distintas y uno ANIDADO se une a la exterior, igual que allí.
 *
 * NO deshace nada si el trabajo lanza: los dobles de repositorio no tienen
 * instantáneas a las que volver. Eso lo hace MENOS permisivo que Postgres, no
 * más: tras un fallo deja más estado del que dejaría la base de datos, así que
 * un test que afirme el rollback con este doble da rojo, nunca un verde falso.
 * El rollback se prueba contra Postgres (`test/e2e/rsvp.e2e.test.ts`).
 */
export class UnidadDeTrabajoEnMemoria implements UnidadDeTrabajo {
  transacciones = 0
  private readonly contexto = new AsyncLocalStorage<true>()

  /** `true` si quien pregunta corre dentro de un `ejecutar`. */
  get activa(): boolean {
    return this.contexto.getStore() === true
  }

  async ejecutar<T>(trabajo: () => Promise<T>): Promise<T> {
    if (this.activa) return await trabajo()
    this.transacciones += 1
    return await this.contexto.run(true, trabajo)
  }
}
