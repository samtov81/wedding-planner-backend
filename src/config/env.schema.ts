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
 * El secreto de ejemplo de `.env.example`. Es público (está en el repo): un
 * despliegue que lo copie firma tokens que cualquiera puede falsificar. Un test
 * lee `.env.example` para que esta constante no se desincronice.
 */
const JWT_SECRET_DE_EJEMPLO = 'cambia-esto-por-32-caracteres-o-mas'

/**
 * TLDs reservados (RFC 2606 / RFC 6761) más los nombres de segundo nivel que
 * RFC 2606 reserva bajo `.com`/`.net`/`.org` (`example.com` y compañía):
 * ningún correo sale ni llega de ellos. El `MAIL_FROM` por defecto usa `.test`
 * para que local y test no puedan mandar nada real; en producción ese
 * remitente sólo produciría rebotes. Se comprueba contra el DOMINIO del
 * correo (ver `dominioDe`), nunca contra la dirección completa: la parte
 * local podría contener por casualidad la palabra "invalid" sin que eso diga
 * nada del dominio.
 */
const TLD_RESERVADO = /(\.(test|example|invalid|localhost)|(^|[.@])example\.(com|net|org))$/i

/** El dominio de un correo: lo que sigue a la última `@`. */
function dominioDe(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1)
}

/**
 * Entorno del backend. Cada variable se valida al arrancar: un secreto ausente
 * tiene que romper el arranque, no la primera petición que lo necesite.
 *
 * Se exporta también sin el `.transform` final (que resuelve el defecto de
 * `DOCS_ENABLED`) porque ese `.transform` envuelve el objeto en un
 * `ZodEffects` sin `.shape`; el test de `.env.example` necesita la lista de
 * claves del objeto base.
 */
export const objetoBaseDeEntorno = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** 32 bytes es el mínimo razonable para HS256; por debajo el secreto es el eslabón débil. */
  JWT_ACCESS_SECRET: z.string().min(32),
  /** Duración de `jsonwebtoken`/`ms`: un número seguido de s, m, h o d. Vacío = por defecto. */
  JWT_ACCESS_TTL: z.preprocess(
    (valor) => (valor === '' ? undefined : valor),
    z
      .string()
      .regex(/^\d+[smhd]$/, 'Duración como 15m, 1h o 30s')
      .default('15m'),
  ),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * `fake` guarda los correos EN MEMORIA (con el enlace del RSVP en claro) y no
   * envía nada: sólo sirve para local y test. En producción
   * `validarReglasCruzadas` exige `resend`.
   */
  MAIL_DRIVER: z.enum(['fake', 'resend']).default('fake'),
  MAIL_FROM: z.email().default('no-reply@weddingplanner.test'),
  RESEND_API_KEY: opcional(z.string().min(1)),
  /**
   * Secreto de firma del webhook de Resend (Svix): `whsec_` + base64. Se valida
   * la FORMA aquí porque un secreto mal copiado no falla hasta el primer
   * webhook, y entonces lo hace como 401 silenciosos que Resend reintenta.
   */
  RESEND_WEBHOOK_SECRET: opcional(
    z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/, 'Debe ser un secreto de Svix: whsec_<base64>'),
  ),

  /** Origen del frontend: base de los enlaces de RSVP y allowlist de CORS. */
  APP_URL: z.url({ protocol: /^https?$/ }),
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

  /**
   * Swagger (`GET /docs` y `GET /openapi.json`) se sirve salvo que se apague
   * explícitamente. Sin fijar: encendido fuera de producción, apagado en
   * producción (el `.transform` de abajo resuelve ese defecto, porque
   * depende de `NODE_ENV`).
   */
  DOCS_ENABLED: opcional(z.enum(['true', 'false']).transform((v) => v === 'true')),
})

/**
 * El defecto de `DOCS_ENABLED` depende de `NODE_ENV`, así que no puede ir en
 * `.default()` del propio campo. Esto es sólo cálculo de un valor, no
 * validación: no añade issues, así que puede vivir aquí sin afectar a "un
 * error no oculta otros" (ver `validarReglasCruzadas`).
 */
export const envSchema = objetoBaseDeEntorno.transform((env) => ({
  ...env,
  DOCS_ENABLED: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production',
}))

export type Env = z.infer<typeof envSchema>

/** Un fallo de `validarReglasCruzadas`, con la misma forma que un issue de Zod. */
export interface EnvIssue {
  readonly path: string[]
  readonly message: string
}

// Sub-esquemas para los campos que las reglas cruzadas necesitan, con las
// mismas reglas y defectos que sus equivalentes en el objeto principal.
// Deliberadamente duplicados: leerlos del entorno CRUDO (no del resultado del
// objeto base) es lo que permite evaluarlos aunque otra variable, como PORT,
// rompa el parseo base.
const NODE_ENV_CRUDO = z.enum(['development', 'test', 'production']).default('development')
const MAIL_DRIVER_CRUDO = z.enum(['fake', 'resend']).default('fake')
const MAIL_FROM_CRUDO = z.email().default('no-reply@weddingplanner.test')
const JWT_ACCESS_SECRET_CRUDO = z.string().min(32)
const RESEND_WEBHOOK_SECRET_CRUDO = opcional(
  z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/, 'Debe ser un secreto de Svix: whsec_<base64>'),
)

/**
 * Reglas que cruzan varios campos: en producción, el fake de correo marcaría
 * cada invitación como SENT sin que nadie reciba nada (y guardaría cada token
 * vivo en el heap), así que exige `resend`, un remitente no reservado y un
 * secreto JWT distinto del de `.env.example`. Con `MAIL_DRIVER=resend` salen
 * correos reales y Resend llamará al webhook: sin secreto, el arranque falla
 * aquí y no en el primer webhook. Con `fake` no hay correos reales que casar,
 * así que el secreto es opcional y la ruta rechaza todo (ver
 * `SvixSignatureVerifier`).
 *
 * Vive FUERA de `envSchema` a propósito. Un `superRefine` sobre un `z.object`
 * sólo se ejecuta si TODO el objeto parsea sin issues: con estas reglas ahí
 * dentro, `PORT=abc` haría desaparecer del mensaje el aviso de `MAIL_DRIVER`
 * en producción, y reiniciar dos veces para descubrir dos variables mal es
 * justo lo que `loadEnv` existe para evitar. Por eso cada campo se parsea
 * suelto desde el entorno crudo (`source`, no el resultado de `envSchema`) y
 * `loadEnv` combina esta lista de issues con la del objeto base.
 */
export function validarReglasCruzadas(source: NodeJS.ProcessEnv): EnvIssue[] {
  const nodeEnv = NODE_ENV_CRUDO.safeParse(source.NODE_ENV)
  const mailDriver = MAIL_DRIVER_CRUDO.safeParse(source.MAIL_DRIVER)
  const issues: EnvIssue[] = []

  if (nodeEnv.success && nodeEnv.data === 'production') {
    if (mailDriver.success && mailDriver.data !== 'resend') {
      issues.push({
        path: ['MAIL_DRIVER'],
        message: 'En producción debe ser `resend`: `fake` no envía ningún correo',
      })
    }

    const mailFrom = MAIL_FROM_CRUDO.safeParse(source.MAIL_FROM)
    if (mailFrom.success && TLD_RESERVADO.test(dominioDe(mailFrom.data))) {
      issues.push({
        path: ['MAIL_FROM'],
        message: 'En producción no puede ser un dominio reservado (.test, .example…)',
      })
    }

    const jwtSecret = JWT_ACCESS_SECRET_CRUDO.safeParse(source.JWT_ACCESS_SECRET)
    if (jwtSecret.success && jwtSecret.data === JWT_SECRET_DE_EJEMPLO) {
      issues.push({
        path: ['JWT_ACCESS_SECRET'],
        message: 'En producción no puede ser el valor de ejemplo de .env.example',
      })
    }
  }

  const webhookSecret = RESEND_WEBHOOK_SECRET_CRUDO.safeParse(source.RESEND_WEBHOOK_SECRET)
  if (
    mailDriver.success &&
    mailDriver.data === 'resend' &&
    webhookSecret.success &&
    webhookSecret.data === undefined
  ) {
    issues.push({
      path: ['RESEND_WEBHOOK_SECRET'],
      message: 'Obligatorio con MAIL_DRIVER=resend: sin él no se puede verificar el webhook',
    })
  }

  return issues
}

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
