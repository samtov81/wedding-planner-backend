import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

import { env } from '../../config/env';
import type {
  PushPort,
  SendPushToDeviceInput,
  SendPushToTopicInput,
} from '../../modules/notifications/ports/push.port';

export class FcmPushAdapter implements PushPort {
  private readonly messaging: Messaging;

  constructor() {
    if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
      throw new Error('Push notifications are not configured: missing FCM_* environment variables');
    }

    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId: env.FCM_PROJECT_ID,
          clientEmail: env.FCM_CLIENT_EMAIL,
          privateKey: env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });

    this.messaging = getMessaging(app);
  }

  async sendToDevice({ token, title, body, data }: SendPushToDeviceInput): Promise<void> {
    await this.messaging.send({
      token,
      notification: { title, body },
      data,
    });
  }

  async sendToTopic({ topic, title, body, data }: SendPushToTopicInput): Promise<void> {
    await this.messaging.send({
      topic,
      notification: { title, body },
      data,
    });
  }
}
