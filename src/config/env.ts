import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

// Cascading env files. dotenv never overwrites an already-defined variable, so
// the first file that defines a key wins - and the real process env (CI,
// Docker, PM2) always beats every file.
//
//   .env.<NODE_ENV>.local  ->  machine-specific overrides (gitignored)
//   .env.<NODE_ENV>        ->  per-environment defaults
//   .env.local             ->  shared local overrides (gitignored)
//   .env                   ->  shared fallback
const nodeEnv = process.env.NODE_ENV ?? 'development';

for (const file of [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env.local', '.env']) {
  dotenv.config({ path: path.resolve(process.cwd(), file) });
}

/** "false" is truthy for z.coerce.boolean(), so parse the string explicitly. */
const booleanFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true' || value === '1');

const csvList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1, 'must contain at least one value'));

const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-long-random-value',
  'test-secret-key-not-for-production',
]);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    APP_URL: z.string().url().default('http://localhost:3000'),
    /** Public URL of the frontend, used to build email links (reset, verify). */
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    CORS_ORIGIN: csvList.default('http://localhost:5173'),
    LOG_LEVEL: z.string().default('info'),
    /** Number of reverse proxies in front of the app; 0 disables trust proxy. */
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    JWT_ISSUER: z.string().default('backend-base'),
    JWT_AUDIENCE: z.string().default('backend-base-api'),
    /** Leave empty for host-only cookies (the safe default outside subdomain setups). */
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: booleanFromString(false),

    STORAGE_PROVIDER: z.enum(['r2']).default('r2'),
    R2_ENDPOINT: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PUBLIC_URL: z.string().optional(),

    /** "log" prints emails instead of sending them (local development only). */
    EMAIL_PROVIDER: z.enum(['sendgrid', 'log']).default('sendgrid'),
    SENDGRID_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('no-reply@example.com'),

    PUSH_PROVIDER: z.enum(['fcm']).default('fcm'),
    FCM_PROJECT_ID: z.string().optional(),
    FCM_CLIENT_EMAIL: z.string().optional(),
    FCM_PRIVATE_KEY: z.string().optional(),
  })
  // Production must never boot with development leftovers: an example secret or
  // a cookie without Secure is a full account-takeover vector.
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') {
      return;
    }

    const reject = (field: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });

    if (value.JWT_ACCESS_SECRET.length < 32 || PLACEHOLDER_SECRETS.has(value.JWT_ACCESS_SECRET)) {
      reject(
        'JWT_ACCESS_SECRET',
        'in production must be a unique random value of at least 32 characters',
      );
    }
    if (!value.COOKIE_SECURE) {
      reject('COOKIE_SECURE', 'must be true in production');
    }
    if (!value.APP_URL.startsWith('https://')) {
      reject('APP_URL', 'must use https in production');
    }
    if (value.CORS_ORIGIN.some((origin) => origin === '*' || origin.startsWith('http://'))) {
      reject('CORS_ORIGIN', 'must list explicit https origins in production (no "*", no http)');
    }
    if (value.EMAIL_PROVIDER === 'log') {
      reject('EMAIL_PROVIDER', 'cannot be "log" in production');
    }
    if (value.EMAIL_PROVIDER === 'sendgrid' && !value.SENDGRID_API_KEY) {
      reject('SENDGRID_API_KEY', 'is required in production');
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    `Invalid environment variables (NODE_ENV=${nodeEnv}):`,
    parsed.error.flatten().fieldErrors,
  );
  throw new Error('Invalid environment variables');
}

export const env = parsed.data;
export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
