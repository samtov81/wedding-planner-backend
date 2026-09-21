import { randomBytes } from 'node:crypto'

export const HORAS_DE_VALIDEZ_VERIFICACION = 48

export function generarTokenVerificacion(): string {
  // Token opaco en base64url, sin hash. El hash se calcula donde se necesita
  // (use-case, al persistir) usando hashToken de token.service.ts.
  return randomBytes(32).toString('base64url')
}

export function caducidadVerificacion(horas: number, desde = new Date()): Date {
  return new Date(desde.getTime() + horas * 3_600_000)
}

export type EmailVerificationStatus = 'PENDING' | 'CONSUMED'
