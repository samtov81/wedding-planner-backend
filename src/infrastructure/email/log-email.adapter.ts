import { logger } from '../../config/logger';
import type { EmailPort, SendEmailInput } from '../../modules/notifications/ports/email.port';
import { renderTemplate } from './template-renderer';

/**
 * Writes the rendered email to the log instead of sending it. Lets the whole
 * signup flow (verification and reset links included) be exercised locally
 * without provider credentials. Never selected in production - env validation
 * requires a real provider key there.
 */
export class LogEmailAdapter implements EmailPort {
  async send({ to, subject, template, data }: SendEmailInput): Promise<void> {
    logger.info(
      { to, subject, template, html: renderTemplate(template, data) },
      'Email not sent (log provider)',
    );
  }
}
