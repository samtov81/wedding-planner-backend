import { z } from 'zod'

/**
 * Validación con Zod, como en `config/env.schema.ts`: no hay `class-validator`
 * instalado en el proyecto y no se añade sólo para esto.
 */
export const registerSchema = z.object({
  email: z.email(),
  /** Longitud, no complejidad: los requisitos de "1 mayúscula, 1 símbolo…"
   * empujan a la gente a patrones predecibles y no añaden entropía real. */
  password: z.string().min(8),
  fullName: z.string().trim().min(1),
})
export type RegisterDto = z.infer<typeof registerSchema>

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})
export type LoginDto = z.infer<typeof loginSchema>

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
})
export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>
