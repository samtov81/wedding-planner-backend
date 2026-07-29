import { R2StorageAdapter } from '../infrastructure/storage/r2-storage.adapter';
import { LogEmailAdapter } from '../infrastructure/email/log-email.adapter';
import { SendgridEmailAdapter } from '../infrastructure/email/sendgrid-email.adapter';
import { FcmPushAdapter } from '../infrastructure/push/fcm-push.adapter';
import type { StoragePort } from '../modules/storage/ports/storage.port';
import type { EmailPort } from '../modules/notifications/ports/email.port';
import type { PushPort } from '../modules/notifications/ports/push.port';
import { env, isProduction } from './env';

// Lazily instantiated singletons: business code depends only on the port
// interfaces above. Adding a new provider means adding a case here and a new
// adapter class under src/infrastructure/<provider>/ — call sites never change.

let storageProvider: StoragePort | undefined;
export function getStorageProvider(): StoragePort {
  if (!storageProvider) {
    switch (env.STORAGE_PROVIDER) {
      case 'r2':
        storageProvider = new R2StorageAdapter();
        break;
      default:
        throw new Error(`Unsupported storage provider: ${env.STORAGE_PROVIDER as string}`);
    }
  }
  return storageProvider;
}

let emailProvider: EmailPort | undefined;
export function getEmailProvider(): EmailPort {
  if (!emailProvider) {
    switch (env.EMAIL_PROVIDER) {
      case 'sendgrid':
        // Outside production a missing key degrades to logging instead of
        // crashing the worker, so the signup flow stays testable locally.
        emailProvider =
          env.SENDGRID_API_KEY || isProduction
            ? new SendgridEmailAdapter()
            : new LogEmailAdapter();
        break;
      case 'log':
        emailProvider = new LogEmailAdapter();
        break;
      default:
        throw new Error(`Unsupported email provider: ${env.EMAIL_PROVIDER as string}`);
    }
  }
  return emailProvider;
}

let pushProvider: PushPort | undefined;
export function getPushProvider(): PushPort {
  if (!pushProvider) {
    switch (env.PUSH_PROVIDER) {
      case 'fcm':
        pushProvider = new FcmPushAdapter();
        break;
      default:
        throw new Error(`Unsupported push provider: ${env.PUSH_PROVIDER as string}`);
    }
  }
  return pushProvider;
}
