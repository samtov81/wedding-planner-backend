import { envSchema, type Env } from './env.schema'

export class EnvValidationError extends Error {
  constructor(detalle: string) {
    super(`Configuración de entorno inválida:\n${detalle}`)
    this.name = 'EnvValidationError'
  }
}

/**
 * Valida el entorno y devuelve un objeto tipado. Acumula TODOS los fallos en un
 * único mensaje: reiniciar tres veces para descubrir tres variables mal es
 * exactamente lo que esta función existe para evitar.
 */
export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const resultado = envSchema.safeParse(source)

  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new EnvValidationError(detalle)
  }

  return resultado.data
}
