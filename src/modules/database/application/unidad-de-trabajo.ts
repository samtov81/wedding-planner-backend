/**
 * Unidad de trabajo: todo lo que los repositorios escriban dentro de
 * `ejecutar` se confirma junto o no se confirma. Si `trabajo` lanza, se
 * deshace entero y el error sale tal cual.
 *
 * Es un puerto y no un `prisma.$transaction` en el caso de uso por la regla de
 * dependencia: `application/` no conoce Prisma. Tampoco recibe ni pasa un
 * cliente transaccional — los repositorios que participan lo recogen solos del
 * contexto (ver `clienteDe` en `database/transaccion.ts`), así que sus firmas
 * de puerto no cambian por estar dentro o fuera de una transacción.
 *
 * Contrato para quien implemente un repositorio de Prisma: si puede llamarse
 * dentro de una unidad de trabajo, escribe con `clienteDe(this.prisma)`, NO con
 * `this.prisma`. Con `this.prisma` la escritura va por otra conexión: se
 * confirma aunque la transacción se deshaga y, si toca una fila que la
 * transacción ya bloqueó, espera a una transacción que la está esperando a ella.
 *
 * Anidar es unirse: un `ejecutar` dentro de otro no abre una segunda
 * transacción, corre dentro de la que ya hay.
 */
export interface UnidadDeTrabajo {
  ejecutar<T>(trabajo: () => Promise<T>): Promise<T>
}

export const UNIDAD_DE_TRABAJO = Symbol('UNIDAD_DE_TRABAJO')
