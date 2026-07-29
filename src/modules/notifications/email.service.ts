import { emailQueue } from '../../infrastructure/queue/queue.registry';
import type { SendEmailInput } from './ports/email.port';

// Requests never call the email provider inline; they enqueue a job and a
// worker process (src/worker.ts) delivers it via the configured EmailPort.
// This keeps request latency independent of the email provider and gives us
// retries via BullMQ's job options.
export const emailService = {
  async enqueue(input: SendEmailInput): Promise<void> {
    await emailQueue.add('send-email', input);
  },
};
