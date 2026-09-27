import { pushQueue } from '../../infrastructure/queue/queue.registry';
import type { SendPushToDeviceInput, SendPushToTopicInput } from './ports/push.port';

export const pushService = {
  async enqueueToDevice(input: SendPushToDeviceInput): Promise<void> {
    await pushQueue.add('send-push-device', input);
  },

  async enqueueToTopic(input: SendPushToTopicInput): Promise<void> {
    await pushQueue.add('send-push-topic', input);
  },
};
