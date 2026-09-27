import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

import { TooManyRequestsError } from '../../common/errors/app-error';
import { logger } from '../../config/logger';
import { redis } from '../../infrastructure/redis/redis.client';

// Two independent counters, per OWASP's brute-force guidance:
//   - per account: stops password spraying against one user from a botnet,
//     which an IP-only limiter never sees.
//   - per IP + account: absorbs the honest "I mistyped my password" case
//     without locking the account for everyone else.
// Neither one can lock a user out forever - both expire on their own.
const byAccount = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:login:account',
  points: 10,
  duration: 15 * 60,
  blockDuration: 15 * 60,
});

const byIpAndAccount = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:login:ip-account',
  points: 5,
  duration: 15 * 60,
  blockDuration: 15 * 60,
});

function pairKey(email: string, ip: string): string {
  return `${ip}|${email}`;
}

/**
 * Redis being down must not lock everybody out of the app, so throttling fails
 * open (logged) - the IP rate limiter on the route behaves the same way.
 */
function isLimiterOutage(err: unknown): boolean {
  if (err instanceof RateLimiterRes) {
    return false;
  }
  logger.error({ err }, 'Login throttle error, allowing attempt through');
  return true;
}

export const loginThrottle = {
  /** Call before verifying the password. Throws 429 while blocked. */
  async assertNotBlocked(email: string, ip: string): Promise<void> {
    try {
      const [account, pair] = await Promise.all([
        byAccount.get(email),
        byIpAndAccount.get(pairKey(email, ip)),
      ]);

      const blocked = [account, pair].some((entry) => entry !== null && entry.remainingPoints <= 0);

      if (blocked) {
        throw new TooManyRequestsError('Too many failed login attempts, try again later');
      }
    } catch (err) {
      if (err instanceof TooManyRequestsError) {
        throw err;
      }
      if (!isLimiterOutage(err)) {
        throw err;
      }
    }
  },

  /** Call after a failed password check. */
  async consumeFailure(email: string, ip: string): Promise<void> {
    try {
      await Promise.all([byAccount.consume(email), byIpAndAccount.consume(pairKey(email, ip))]);
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        return;
      }
      isLimiterOutage(err);
    }
  },

  /** Call after a successful login so a legitimate user starts fresh. */
  async reset(email: string, ip: string): Promise<void> {
    try {
      await Promise.all([byAccount.delete(email), byIpAndAccount.delete(pairKey(email, ip))]);
    } catch (err) {
      isLimiterOutage(err);
    }
  },
};
