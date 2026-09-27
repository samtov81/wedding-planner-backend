/** Una dependencia que la readiness tiene que poder alcanzar. */
export interface Comprobacion {
  readonly nombre: 'db' | 'redis'
  /** `true` si responde a tiempo. NUNCA lanza: un fallo es un `false`. */
  comprobar(): Promise<boolean>
}

export const COMPROBACIONES = Symbol('COMPROBACIONES')

/**
 * Tope de cada comprobación. Con la base de datos caída, Prisma espera su
 * `pool_timeout` (10 s por defecto) y el sondeo del orquestador vencería antes
 * de recibir el 503; mejor un "no" rápido que ningún "sí".
 */
export const TIEMPO_MAXIMO_MS = 2_000

/** `promesa` o `false` si tarda más de `ms` o falla. */
export async function aTiempo(promesa: Promise<unknown>, ms = TIEMPO_MAXIMO_MS): Promise<boolean> {
  let reloj: NodeJS.Timeout | undefined
  const tarde = new Promise<boolean>((resolve) => {
    reloj = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promesa.then(() => true), tarde])
  } catch {
    return false
  } finally {
    clearTimeout(reloj)
  }
}
