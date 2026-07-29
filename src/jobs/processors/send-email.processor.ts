import { Worker, type Job } from 'bullmq';

import { getEmailProvider } from '../../config/providers';
import { queueConnection } from '../../infrastructure/queue/connection';
import { QueueName } from '../../infrastructure/queue/queue.registry';
import type { SendEmailInput } from '../../modules/notifications/ports/email.port';

export function createSendEmailWorker(): Worker<SendEmailInput> {
  return new Worker<SendEmailInput>(
    QueueName.EMAIL,
    async (job: Job<SendEmailInput>) => {
      await getEmailProvider().send(job.data);
    },
    { connection: queueConnection, concurrency: 5 },
  );
}
