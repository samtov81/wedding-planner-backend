import type { NextFunction, Request, Response } from 'express';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

import { TooManyRequestsError } from '../common/errors/app-error';
import { logger } from '../config/logger';
import { redis } from '../infrastructure/redis/redis.client';

export function createRateLimiter(options: { keyPrefix: string; points: number; durationSeconds: number }) {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: options.keyPrefix,
    points: options.points,
    duration: options.durationSeconds,
  });

  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    limiter
      .consume(key)
      .then(() => next())
      .catch((err: unknown) => {
        if (err instanceof RateLimiterRes) {
          next(new TooManyRequestsError());
          return;
        }
        // Redis is unreachable or errored: fail open rather than blocking all
        // traffic on an infrastructure hiccup.
        logger.error({ err }, 'Rate limiter error, allowing request through');
        next();
      });
  };
}
