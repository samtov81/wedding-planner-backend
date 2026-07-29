import crypto from 'node:crypto';

import { redis } from '../../infrastructure/redis/redis.client';

export type TokenPurpose = 'pwreset' | 'emailverify';

/**
 * Single-use, expiring tokens for email links (password reset, email
 * verification). Only the SHA-256 hash is stored, so a dump of Redis does not
 * hand out working links; the token itself exists only inside the email.
 * Consuming is atomic (GETDEL), so a leaked link can't be replayed.
 */
function key(purpose: TokenPurpose, token: string): string {
  return `${purpose}:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

export const oneTimeToken = {
  async issue(purpose: TokenPurpose, userId: string, ttlSeconds: number): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    await redis.set(key(purpose, token), userId, 'EX', ttlSeconds);
    return token;
  },

  /** Returns the user id and invalidates the token, or null if unknown/expired. */
  async consume(purpose: TokenPurpose, token: string): Promise<string | null> {
    return redis.getdel(key(purpose, token));
  },
};
