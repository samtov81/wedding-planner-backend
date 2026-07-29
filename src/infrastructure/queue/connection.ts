import type { ConnectionOptions } from 'bullmq';

import { env } from '../../config/env';

// BullMQ takes ioredis connection options (or a shared client with
// maxRetriesPerRequest: null); passing the URL directly keeps this in one place.
export const queueConnection: ConnectionOptions = {
  ...parseRedisUrl(env.REDIS_URL),
  maxRetriesPerRequest: null,
};

function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    password: parsed.password || undefined,
  };
}
