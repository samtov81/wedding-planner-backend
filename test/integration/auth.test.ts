import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma.client';
import { redis } from '../../src/infrastructure/redis/redis.client';
import { emailService } from '../../src/modules/notifications/email.service';

/**
 * End-to-end auth flow against real Postgres + Redis.
 *   docker compose up -d && pnpm prisma migrate deploy
 * Skipped automatically when that infrastructure isn't reachable, so `pnpm test`
 * stays green on a bare checkout.
 */
async function infraAvailable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

const available = await infraAvailable();

/** Emails are queued, never sent inline - capture the payload instead. */
const sentEmails: { template: string; data: Record<string, unknown> }[] = [];

function lastEmail(template: string): Record<string, unknown> | undefined {
  return [...sentEmails].reverse().find((email) => email.template === template)?.data;
}

function tokenFromUrl(url: unknown): string {
  return new URL(String(url)).searchParams.get('token') ?? '';
}

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const entry = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return new RegExp(`${name}=([^;]*)`).exec(entry ?? '')?.[1] ?? '';
}

describe.skipIf(!available)('auth flow', () => {
  const email = `test-${Date.now()}@example.com`;
  const password = 'una-frase-larga-2026';
  let agent: TestAgent;
  let csrfToken = '';

  beforeAll(async () => {
    vi.spyOn(emailService, 'enqueue').mockImplementation(async (input) => {
      sentEmails.push({ template: input.template, data: input.data ?? {} });
    });

    // Rate-limit counters live in Redis and would otherwise leak between runs.
    const stale = await redis.keys('rl:*');
    if (stale.length > 0) {
      await redis.del(...stale);
    }

    agent = request.agent(createApp());
    const res = await agent.get('/api/auth/csrf');
    csrfToken = res.body.data.csrfToken as string;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await redis.quit();
    await prisma.$disconnect();
  });

  const post = (path: string, body?: unknown) =>
    agent.post(path).set('X-CSRF-Token', csrfToken).send(body ?? {});

  /** Login rotates the CSRF cookie; a real client re-reads it the same way. */
  async function login() {
    const res = await post('/api/auth/login', { email, password });
    const rotated = cookieFrom(res, 'csrf_token');
    if (rotated) {
      csrfToken = rotated;
    }
    return res;
  }

  it('rejects a state-changing request without the CSRF header', async () => {
    const res = await agent.post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_ERROR');
  });

  it('rejects weak passwords at registration', async () => {
    const res = await post('/api/auth/register', { email, password: 'password123' });
    expect(res.status).toBe(422);
  });

  it('registers without revealing whether the email existed', async () => {
    const first = await post('/api/auth/register', { email, password });
    expect(first.status).toBe(202);

    const second = await post('/api/auth/register', { email, password });
    expect(second.status).toBe(202);
    expect(second.body).toEqual(first.body);
  });

  it('refuses login until the email is verified', async () => {
    const res = await post('/api/auth/login', { email, password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('verifies the email and logs in', async () => {
    const token = tokenFromUrl(lastEmail('verify-email')?.verifyUrl);
    expect(token).not.toBe('');

    const verified = await post('/api/auth/verify-email/confirm', { token });
    expect(verified.status).toBe(200);

    // Single use: the same link must not work twice.
    const replay = await post('/api/auth/verify-email/confirm', { token });
    expect(replay.status).toBe(401);

    const loggedIn = await login();
    expect(loggedIn.status).toBe(200);

    const me = await agent.get('/api/users/me');
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(email);
    expect(me.body.data.isEmailVerified).toBe(true);
  });

  it('rejects a wrong password with the same message as an unknown account', async () => {
    const wrongPassword = await post('/api/auth/login', { email, password: 'definitely-wrong-1' });
    const unknownUser = await post('/api/auth/login', {
      email: `missing-${Date.now()}@example.com`,
      password: 'definitely-wrong-1',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('rotates the refresh token and revokes the session on reuse', async () => {
    const stolen = cookieFrom(await login(), 'refresh_token');
    expect(stolen).not.toBe('');

    const rotated = await post('/api/auth/refresh');
    expect(rotated.status).toBe(200);
    expect(cookieFrom(rotated, 'refresh_token')).not.toBe(stolen);

    // Replaying the pre-rotation token must kill the whole session.
    const replay = await request(createApp())
      .post('/api/auth/refresh')
      .set('Cookie', [`refresh_token=${stolen}`, `csrf_token=${csrfToken}`])
      .set('X-CSRF-Token', csrfToken);
    expect(replay.status).toBe(401);

    const afterReuse = await post('/api/auth/refresh');
    expect(afterReuse.status).toBe(401);
  });

  it('invalidates the access token immediately on logout', async () => {
    await login();
    expect((await agent.get('/api/users/me')).status).toBe(200);

    const loggedOut = await post('/api/auth/logout');
    expect(loggedOut.status).toBe(204);

    // The JWT itself has not expired yet; the session check is what rejects it.
    expect((await agent.get('/api/users/me')).status).toBe(401);
  });
});
