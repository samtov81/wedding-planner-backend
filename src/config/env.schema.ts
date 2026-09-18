import { z } from 'zod'

/**
 * Entorno del backend. Cada variable se valida al arrancar: un secreto ausente
 * tiene que romper el arranque, no la primera petición que lo necesite.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    /** 32 bytes es el mínimo razonable para HS256; por debajo el secreto es el eslabón débil. */
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().default('15m'),
    REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

    /** `fake` escribe los correos a disco; en producción el arranque exige `resend`. */
    MAIL_DRIVER: z.enum(['fake', 'resend']).default('fake'),
    MAIL_FROM: z.email().default('no-reply@weddingplanner.test'),
    RESEND_API_KEY: z.string().min(1).optional(),
    /**
     * Secreto de firma del webhook de Resend (Svix): `whsec_` + base64. Se valida
     * la FORMA aquí porque un secreto mal copiado no falla hasta el primer
     * webhook, y entonces lo hace como 401 silenciosos que Resend reintenta.
     */
    RESEND_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/, 'Debe ser un secreto de Svix: whsec_<base64>')
      .optional(),

    /** Origen del frontend: base de los enlaces de RSVP y allowlist de CORS. */
    APP_URL: z.url(),
    CORS_ORIGINS: z.string().default(''),
  })
  /**
   * Con `MAIL_DRIVER=resend` salen correos reales y Resend llamará al webhook:
   * sin secreto, el arranque falla aquí y no en el primer webhook. Con `fake`
   * no hay correos reales que casar, así que el secreto es opcional y la ruta
   * rechaza todo (ver `SvixSignatureVerifier`).
   */
  .superRefine((env, ctx) => {
    if (env.MAIL_DRIVER === 'resend' && env.RESEND_WEBHOOK_SECRET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_WEBHOOK_SECRET'],
        message: 'Obligatorio con MAIL_DRIVER=resend: sin él no se puede verificar el webhook',
      })
    }
  })

export type Env = z.infer<typeof envSchema>
