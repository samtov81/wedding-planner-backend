import { describe, expect, it } from 'vitest';

import { envSchema } from '../../src/config/env';

const productionBase = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@db:5432/app',
  REDIS_URL: 'rediss://redis:6380',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  APP_URL: 'https://api.example.com',
  FRONTEND_URL: 'https://app.example.com',
  CORS_ORIGIN: 'https://app.example.com',
  COOKIE_SECURE: 'true',
  SENDGRID_API_KEY: 'SG.real-key',
};

function fieldErrors(input: Record<string, string>): Record<string, string[] | undefined> {
  const result = envSchema.safeParse(input);
  return result.success ? {} : result.error.flatten().fieldErrors;
}

describe('env schema', () => {
  it('accepts a complete production configuration', () => {
    expect(envSchema.safeParse(productionBase).success).toBe(true);
  });

  it('parses COOKIE_SECURE=false as false instead of a truthy string', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: 'postgresql://localhost:5432/app',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'dev-secret-value-long-enough',
      COOKIE_SECURE: 'false',
    });
    expect(parsed.COOKIE_SECURE).toBe(false);
  });

  it('splits CORS_ORIGIN into a list', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: 'postgresql://localhost:5432/app',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'dev-secret-value-long-enough',
      CORS_ORIGIN: 'https://a.example.com, https://b.example.com',
    });
    expect(parsed.CORS_ORIGIN).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('rejects a placeholder secret in production', () => {
    const errors = fieldErrors({
      ...productionBase,
      JWT_ACCESS_SECRET: 'change-me-to-a-long-random-value',
    });
    expect(errors.JWT_ACCESS_SECRET).toBeDefined();
  });

  it('rejects insecure cookies, http URLs and wildcard CORS in production', () => {
    const errors = fieldErrors({
      ...productionBase,
      COOKIE_SECURE: 'false',
      APP_URL: 'http://api.example.com',
      CORS_ORIGIN: '*',
    });
    expect(errors.COOKIE_SECURE).toBeDefined();
    expect(errors.APP_URL).toBeDefined();
    expect(errors.CORS_ORIGIN).toBeDefined();
  });

  it('rejects the log email provider and a missing SendGrid key in production', () => {
    expect(fieldErrors({ ...productionBase, EMAIL_PROVIDER: 'log' }).EMAIL_PROVIDER).toBeDefined();
    const withoutKey = { ...productionBase, SENDGRID_API_KEY: '' };
    expect(fieldErrors(withoutKey).SENDGRID_API_KEY).toBeDefined();
  });

  it('allows the same relaxed values in development', () => {
    const result = envSchema.safeParse({
      ...productionBase,
      NODE_ENV: 'development',
      JWT_ACCESS_SECRET: 'change-me-to-a-long-random-value',
      COOKIE_SECURE: 'false',
      APP_URL: 'http://localhost:3000',
      CORS_ORIGIN: 'http://localhost:5173',
    });
    expect(result.success).toBe(true);
  });
});
