export type SystemRole = 'USER' | 'ADMIN'

export interface User {
  id: string
  email: string
  fullName: string
  systemRole: SystemRole
  emailVerifiedAt: Date | null
}

/** Como `User`, pero con el hash. Nunca sale de `application/` hacia fuera. */
export interface UserConHash extends User {
  passwordHash: string
}

/**
 * El email se normaliza SIEMPRE antes de tocar la base de datos. Sin esto,
 * `Ana@test.com` y `ana@test.com` son dos filas distintas para el índice único
 * y una sola persona para el mundo real: dos cuentas, y un login que falla sin
 * que el usuario entienda por qué.
 */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase()
}
