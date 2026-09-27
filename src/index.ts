import http from 'node:http';

import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './infrastructure/database/prisma.client';
import { redis } from './infrastructure/redis/redis.client';
import { createSocketServer } from './modules/realtime/socket.server';

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
});

async function main(): Promise<void> {
  const app = createApp();
  const httpServer = http.createServer(app);

  createSocketServer(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info(`API listening on port ${env.PORT}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    httpServer.close();
    await Promise.all([prisma.$disconnect(), redis.quit()]);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
