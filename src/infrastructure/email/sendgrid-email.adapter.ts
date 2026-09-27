import sgMail from '@sendgrid/mail';

import { env } from '../../config/env';
import type { EmailPort, SendEmailInput } from '../../modules/notifications/ports/email.port';
import { renderTemplate } from './template-renderer';

export class SendgridEmailAdapter implements EmailPort {
  constructor() {
    if (!env.SENDGRID_API_KEY) {
      throw new Error('Email is not configured: missing SENDGRID_API_KEY');
    }
    sgMail.setApiKey(env.SENDGRID_API_KEY);
  }

  async send({ to, subject, template, data }: SendEmailInput): Promise<void> {
    const html = renderTemplate(template, data);

    await sgMail.send({
      to,
      from: env.EMAIL_FROM,
      subject,
      html,
    });
  }
}
