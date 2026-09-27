import { logger } from './config/logger';
import { createCleanupSessionsWorker } from './jobs/processors/cleanup-sessions.processor';
import { createSendEmailWorker } from './jobs/processors/send-email.processor';
import { createSendPushWorker } from './jobs/processors/send-push.processor';

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled promise rejection');
});

function main(): void {
  const workers = [createSendEmailWorker(), createSendPushWorker(), createCleanupSessionsWorker()];

  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      logger.error({ err, jobId: job?.id, queue: worker.name }, 'Job failed');
    });
  }

  logger.info('Worker process started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down workers`);
    await Promise.all(workers.map((worker) => worker.close()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
