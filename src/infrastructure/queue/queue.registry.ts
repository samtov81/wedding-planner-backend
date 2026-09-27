import { Queue } from 'bullmq';

import { queueConnection } from './connection';

export const QueueName = {
  EMAIL: 'email',
  PUSH: 'push',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueNameValue = (typeof QueueName)[keyof typeof QueueName];

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
} as const;

export const emailQueue = new Queue(QueueName.EMAIL, {
  connection: queueConnection,
  defaultJobOptions,
});

export const pushQueue = new Queue(QueueName.PUSH, {
  connection: queueConnection,
  defaultJobOptions,
});

export const maintenanceQueue = new Queue(QueueName.MAINTENANCE, {
  connection: queueConnection,
  defaultJobOptions,
});
