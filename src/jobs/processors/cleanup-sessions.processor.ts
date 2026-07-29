import { Worker } from 'bullmq';

import { prisma } from '../../infrastructure/database/prisma.client';
import { queueConnection } from '../../infrastructure/queue/connection';
import { QueueName } from '../../infrastructure/queue/queue.registry';

const RETENTION_DAYS = 90;

export function createCleanupSessionsWorker(): Worker {
  return new Worker(
    QueueName.MAINTENANCE,
    async (job) => {
      if (job.name !== 'cleanup-expired-sessions') return;

      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await prisma.session.deleteMany({
        where: { revokedAt: { not: null, lt: cutoff } },
      });
    },
    { connection: queueConnection, concurrency: 1 },
  );
}
