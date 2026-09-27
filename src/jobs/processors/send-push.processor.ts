import { Worker, type Job } from 'bullmq';

import { getPushProvider } from '../../config/providers';
import { queueConnection } from '../../infrastructure/queue/connection';
import { QueueName } from '../../infrastructure/queue/queue.registry';
import type {
  SendPushToDeviceInput,
  SendPushToTopicInput,
} from '../../modules/notifications/ports/push.port';

type PushJobData = SendPushToDeviceInput | SendPushToTopicInput;

export function createSendPushWorker(): Worker<PushJobData> {
  return new Worker<PushJobData>(
    QueueName.PUSH,
    async (job: Job<PushJobData>) => {
      const provider = getPushProvider();
      if (job.name === 'send-push-topic') {
        await provider.sendToTopic(job.data as SendPushToTopicInput);
      } else {
        await provider.sendToDevice(job.data as SendPushToDeviceInput);
      }
    },
    { connection: queueConnection, concurrency: 5 },
  );
}
