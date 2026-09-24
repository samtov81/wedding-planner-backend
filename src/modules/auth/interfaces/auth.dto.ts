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

export const resendVerificationSchema = z.object({
  email: z.email(),
})
export type ResendVerificationDto = z.infer<typeof resendVerificationSchema>

export const forgotPasswordSchema = z.object({
  email: z.email(),
})
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>

export const resetPasswordSchema = z.object({
  /** Un token real mide 43; el tope sólo corta basura antes de hashearla. */
  token: z.string().min(1).max(256),
  /** Mismo mínimo que el registro. El máximo acota el trabajo de Argon2. */
  password: z.string().min(8).max(128),
})
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>
