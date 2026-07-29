import type { Server as HttpServer } from 'node:http';

import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';

import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { createRedisClient } from '../../infrastructure/redis/redis.client';
import { registerPingEvent } from './events/ping.event';
import { socketAuthMiddleware } from './socket.auth';

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
  });

  const pubClient = createRedisClient();
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const user = socket.data.user as { id: string; email: string };
    logger.info({ userId: user.id, socketId: socket.id }, 'socket connected');

    // Per-user room so other parts of the app can push events with
    // io.to(`user:${userId}`).emit(...) without tracking socket ids.
    socket.join(`user:${user.id}`);

    registerPingEvent(socket);

    socket.on('disconnect', (reason) => {
      logger.info({ userId: user.id, socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return io;
}
