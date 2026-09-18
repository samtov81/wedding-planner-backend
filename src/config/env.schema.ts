import { isIP } from 'node:net'

import { z } from 'zod'

/**
 * Un ORIGEN tal como lo manda el navegador en la cabecera `Origin`: esquema,
 * host y puerto, sin ruta ni barra final. `https://a.com/` no casa nunca con
 * `Origin: https://a.com`, así que aceptarlo sería un CORS roto en silencio.
 */
function esOrigen(valor: string): boolean {
  try {
    const url = new URL(valor)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === valor
  } catch {
    return false
  }
}

/** Palabras clave de `trust proxy` que Express entiende (subredes con nombre). */
const SUBREDES_CON_NOMBRE = new Set(['loopback', 'linklocal', 'uniquelocal'])

function esDireccionOSubred(valor: string): boolean {
  if (SUBREDES_CON_NOMBRE.has(valor)) return true
  const [ip, prefijo, ...sobra] = valor.split('/')
  if (ip === undefined || sobra.length > 0) return false
  const version = isIP(ip)
  if (version === 0) return false
  if (prefijo === undefined) return true
  if (!/^\d{1,3}$/.test(prefijo)) return false
  return Number(prefijo) <= (version === 4 ? 32 : 128)
}

/**
 * `KEY=` en un `.env` llega como cadena vacía, no como ausente. En las
 * opcionales, vacío significa "sin configurar": así `.env.example` puede listar
 * TODAS las variables sin que las que no se usan en local rompan el arranque.
 */
function opcional<T extends z.ZodType>(esquema: T) {
  return z.preprocess((valor) => (valor === '' ? undefined : valor), esquema.optional())
}

/** Lista separada por comas → elementos recortados y no vacíos. */
function trocear(valor: string): string[] {
  return valor
    .split(',')
    .map((parte) => parte.trim())
    .filter((parte) => parte !== '')
}

/**
 * `trust proxy` de Express, que decide de dónde sale `req.ip` y por tanto la
 * clave de TODOS los límites de ritmo:
 *  - sin configurar / `false` / `0`: `req.ip` es el par TCP. Correcto sin proxy;
 *    detrás de un balanceador, todos los clientes serían la IP del balanceador.
 *  - un número N: confía en N saltos (lo normal: `1` detrás de un balanceador).
 *  - una lista de IPs, subredes o `loopback`/`linklocal`/`uniquelocal`: confía
 *    sólo en proxies con esas direcciones.
 *
 * `true` se RECHAZA a propósito: confía en cualquier `X-Forwarded-For`, y
 * `req.ip` pasa a ser el primer valor de la cabecera, que escribe el cliente.
 * Cada petición con una IP inventada tendría su propio contador: los límites
 * dejarían de existir.
 */
const trustProxySchema = z
  .string()
  .default('false')
  .transform((valor, ctx): false | number | string[] => {
    const limpio = valor.trim()
    if (limpio === '' || limpio === 'false') return false
    if (limpio === 'true') {
      ctx.addIssue({
        code: 'custom',
        message:
          '`true` confía en cualquier X-Forwarded-For y deja falsear la IP: usa el número de ' +
          'proxies (p. ej. 1) o sus direcciones',
      })
      return z.NEVER
    }
    if (/^\d+$/.test(limpio)) {
      const saltos = Number(limpio)
      return saltos === 0 ? false : saltos
    }
    const lista = trocear(limpio)
    const invalidas = lista.filter((parte) => !esDireccionOSubred(parte))
    if (invalidas.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `No es un número de saltos ni una IP/subred: ${invalidas.join(', ')}`,
      })
      return z.NEVER
    }
    return lista
  })

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
    RESEND_API_KEY: opcional(z.string().min(1)),
    /**
     * Secreto de firma del webhook de Resend (Svix): `whsec_` + base64. Se valida
     * la FORMA aquí porque un secreto mal copiado no falla hasta el primer
     * webhook, y entonces lo hace como 401 silenciosos que Resend reintenta.
     */
    RESEND_WEBHOOK_SECRET: opcional(
      z
        .string()
        .regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/, 'Debe ser un secreto de Svix: whsec_<base64>'),
    ),

    /** Origen del frontend: base de los enlaces de RSVP y allowlist de CORS. */
    APP_URL: z.url(),
    /**
     * Orígenes ADICIONALES a `APP_URL` que pueden llamar a la API y abrir el
     * socket, separados por comas. Nunca `*` (ver `origenesPermitidos`).
     */
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((valor) => trocear(valor))
      .refine((lista) => lista.every(esOrigen), {
        message: 'Cada origen debe ser exactamente esquema://host[:puerto], sin ruta ni `*`',
      }),

    TRUST_PROXY: trustProxySchema,

    /** Nivel de pino. Sin fijar: `silent` en test, `info` en el resto. */
    LOG_LEVEL: opcional(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])),
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

/**
 * La ÚNICA allowlist de orígenes, compartida por el HTTP (`enableCors`) y por
 * Socket.IO (`RedisIoAdapter`): dos listas acabarían divergiendo y el frontend
 * podría llamar a la API pero no abrir el socket, o al revés.
 *
 * `APP_URL` entra siempre: es el frontend que manda los enlaces del RSVP, así
 * que tiene que poder llamar a la API. Allowlist explícita y nunca `*`: con
 * credenciales (la cookie del refresh) `*` ni siquiera es legal, y sin ellas
 * seguiría abriendo la API a cualquier página.
 */
export function origenesPermitidos(env: Pick<Env, 'APP_URL' | 'CORS_ORIGINS'>): string[] {
  return [...new Set([new URL(env.APP_URL).origin, ...env.CORS_ORIGINS])]
}
