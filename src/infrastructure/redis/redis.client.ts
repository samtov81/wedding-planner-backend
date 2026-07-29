import Redis from 'ioredis';

import { env } from '../../config/env';
import { logger } from '../../config/logger';

// Dedicated connections: BullMQ and the Socket.IO adapter each require their
// own ioredis instance (they issue blocking commands), so we don't share one
// client across all consumers. Unlike the BullMQ connection, this one disables
// the offline command queue so requests (e.g. the rate limiter) fail fast with
// a rejected promise instead of queuing indefinitely - and eventually crashing
// the process via MaxRetriesPerRequestError - when Redis is unreachable.
export function createRedisClient(): Redis {
  const client = new Redis(env.REDIS_URL, { enableOfflineQueue: false });
  client.on('error', (err) => logger.error({ err }, 'Redis client error'));
  return client;
}

export const redis = createRedisClient();
