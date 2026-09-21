import { envSchema, validarReglasCruzadas, type Env } from './env.schema'

export class EnvValidationError extends Error {
  constructor(detalle: string) {
    super(`Configuración de entorno inválida:\n${detalle}`)
    this.name = 'EnvValidationError'
  }
}

/**
 * Un issue de Zod (`path: PropertyKey[]`, por los índices numéricos de un
 * array) y un `EnvIssue` de `validarReglasCruzadas` (`path: string[]`, no hay
 * arrays en las reglas cruzadas) comparten forma; `PropertyKey[]` es el tipo
 * más amplio de los dos, así que `formatear` los acepta indistintamente.
 */
function formatear(issue: { path: PropertyKey[]; message: string }): string {
  return `  - ${issue.path.map(String).join('.')}: ${issue.message}`
}

/**
 * Valida el entorno y devuelve un objeto tipado. Acumula TODOS los fallos en un
 * único mensaje: reiniciar tres veces para descubrir tres variables mal es
 * exactamente lo que esta función existe para evitar.
 *
 * Dos pasadas independientes, combinadas en un solo mensaje: el objeto base
 * (`envSchema`) y las reglas cruzadas (`validarReglasCruzadas`), que se leen
 * del entorno crudo y por eso sobreviven aunque el objeto base falle en otra
 * variable (ver el docblock de `validarReglasCruzadas`).
 */
export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const resultado = envSchema.safeParse(source)
  const cruzados = validarReglasCruzadas(source)

  if (resultado.success && cruzados.length === 0) {
    return resultado.data
  }

  const issuesDeBase = resultado.success ? [] : resultado.error.issues.map(formatear)
  const detalle = [...issuesDeBase, ...cruzados.map(formatear)].join('\n')
  throw new EnvValidationError(detalle)
}
