import crypto from 'node:crypto';

import { prisma } from '../../infrastructure/database/prisma.client';
import { redis } from '../../infrastructure/redis/redis.client';
import { env } from '../../config/env';
import { UnauthorizedError } from '../../common/errors/app-error';

export interface SessionMeta {
  userAgent?: string;
  ipAddress?: string;
}

export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
  userId: string;
}

const REFRESH_TTL_SECONDS = env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60;

function redisKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Refresh tokens are rotated on every use. Redis holds the hash of the single
 * currently-valid token per session (fast path, source of truth for rotation).
 * Postgres holds the durable session row for audit trails and bulk revocation
 * ("log out all devices"). A refresh call presenting a token that doesn't match
 * the current hash is treated as reuse of an already-rotated token and revokes
 * the session immediately.
 */
export const sessionService = {
  async create(userId: string, meta: SessionMeta): Promise<CreatedSession> {
    const session = await prisma.session.create({
      data: {
        userId,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
      },
    });

    const refreshToken = generateToken();
    await redis.set(redisKey(session.id), hashToken(refreshToken), 'EX', REFRESH_TTL_SECONDS);

    return { sessionId: session.id, refreshToken, userId };
  },

  /**
   * True while the session key still exists in Redis. Checked on every
   * authenticated request so logout / "log out everywhere" take effect
   * immediately instead of after the access token expires.
   */
  async isActive(sessionId: string): Promise<boolean> {
    return (await redis.exists(redisKey(sessionId))) === 1;
  },

  async rotate(sessionId: string, presentedToken: string): Promise<CreatedSession> {
    const storedHash = await redis.get(redisKey(sessionId));

    if (!storedHash || storedHash !== hashToken(presentedToken)) {
      await this.revoke(sessionId);
      throw new UnauthorizedError('Session is invalid or has been revoked');
    }

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt) {
      throw new UnauthorizedError('Session is invalid or has been revoked');
    }

    const refreshToken = generateToken();
    await redis.set(redisKey(sessionId), hashToken(refreshToken), 'EX', REFRESH_TTL_SECONDS);
    await prisma.session.update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } });

    return { sessionId, refreshToken, userId: session.userId };
  },

  async revoke(sessionId: string): Promise<void> {
    await redis.del(redisKey(sessionId));
    await prisma.session
      .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  },

  async revokeAllForUser(userId: string): Promise<void> {
    const sessions = await prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true },
    });

    if (sessions.length > 0) {
      await redis.del(...sessions.map((s) => redisKey(s.id)));
    }

    await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};
