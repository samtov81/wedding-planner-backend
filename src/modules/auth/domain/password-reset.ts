import { randomBytes } from 'node:crypto'

/**
 * Token opaco del enlace de recuperación. 32 bytes: adivinarlo es inviable, así
 * que el límite de ritmo del endpoint es higiene, no la defensa. Se persiste
 * sólo su hash (`hashToken`), nunca este valor.
 */
export function generarTokenReset(): string {
  return randomBytes(32).toString('base64url')
}

export function caducidadReset(minutos: number, desde = new Date()): Date {
  return new Date(desde.getTime() + minutos * 60_000)
}
