import { EmailNotVerifiedError, UnauthorizedError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { emailService } from '../notifications/email.service';
import { usersRepository } from '../users/users.repository';
import { normalizeEmail } from './email.util';
import { signAccessToken } from './jwt.util';
import { loginThrottle } from './login-throttle.service';
import { oneTimeToken } from './one-time-token.service';
import { hashPassword, verifyDummyPassword, verifyPassword } from './password.util';
import { sessionService, type SessionMeta } from './session.service';

const PASSWORD_RESET_TTL_SECONDS = 15 * 60;
const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

function verificationUrl(token: string): string {
  return `${env.FRONTEND_URL}/verify-email?token=${token}`;
}

async function sendVerificationEmail(user: {
  id: string;
  email: string;
  name: string | null;
}): Promise<void> {
  const token = await oneTimeToken.issue(
    'emailverify',
    user.id,
    EMAIL_VERIFICATION_TTL_SECONDS,
  );

  await emailService.enqueue({
    to: user.email,
    subject: 'Confirm your email address',
    template: 'verify-email',
    data: {
      name: user.name ?? user.email,
      verifyUrl: verificationUrl(token),
      expiresInHours: EMAIL_VERIFICATION_TTL_SECONDS / 3600,
    },
  });
}

export const authService = {
  /**
   * Always resolves with the same outcome whether or not the email is taken:
   * the response must not tell an attacker which addresses are registered.
   * An existing account gets a "someone tried to register" email instead.
   */
  async register(rawEmail: string, password: string, name?: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const existing = await usersRepository.findByEmail(email);

    if (existing) {
      if (existing.isEmailVerified) {
        await emailService.enqueue({
          to: existing.email,
          subject: 'You already have an account',
          template: 'account-exists',
          data: {
            name: existing.name ?? existing.email,
            resetUrl: `${env.FRONTEND_URL}/forgot-password`,
          },
        });
      } else {
        // Unverified duplicate: just resend the confirmation link.
        await sendVerificationEmail(existing);
      }
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = await usersRepository.create({ email, passwordHash, name });

    await sendVerificationEmail(user);
  },

  async verifyEmail(token: string): Promise<void> {
    const userId = await oneTimeToken.consume('emailverify', token);
    if (!userId) {
      throw new UnauthorizedError('Invalid or expired verification token');
    }

    const user = await usersRepository.findById(userId);
    if (!user) {
      throw new UnauthorizedError('Invalid or expired verification token');
    }

    if (!user.isEmailVerified) {
      await usersRepository.markEmailVerified(userId);
      await emailService.enqueue({
        to: user.email,
        subject: 'Welcome!',
        template: 'welcome',
        data: { name: user.name ?? user.email },
      });
    }
  },

  /** Silent for unknown or already-verified accounts (no enumeration). */
  async resendVerification(rawEmail: string): Promise<void> {
    const user = await usersRepository.findByEmail(normalizeEmail(rawEmail));
    if (!user || user.isEmailVerified) {
      return;
    }
    await sendVerificationEmail(user);
  },

  async login(rawEmail: string, password: string, meta: SessionMeta): Promise<AuthTokens> {
    const email = normalizeEmail(rawEmail);
    const ip = meta.ipAddress ?? 'unknown';

    await loginThrottle.assertNotBlocked(email, ip);

    const user = await usersRepository.findByEmail(email);

    if (!user) {
      // Spend the same time as a real verification so response latency does
      // not reveal whether the account exists.
      await verifyDummyPassword();
      await loginThrottle.consumeFailure(email, ip);
      throw new UnauthorizedError('Invalid email or password');
    }

    const passwordMatches = await verifyPassword(user.passwordHash, password);
    if (!passwordMatches) {
      await loginThrottle.consumeFailure(email, ip);
      throw new UnauthorizedError('Invalid email or password');
    }

    // Checked only after the password is proven correct, so the error can't be
    // used to probe which addresses are registered.
    if (!user.isEmailVerified) {
      throw new EmailNotVerifiedError('Confirm your email address before signing in');
    }

    await loginThrottle.reset(email, ip);

    const session = await sessionService.create(user.id, meta);
    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      sid: session.sessionId,
    });

    return { accessToken, refreshToken: session.refreshToken, sessionId: session.sessionId };
  },

  async refresh(sessionId: string, refreshToken: string): Promise<AuthTokens> {
    const rotated = await sessionService.rotate(sessionId, refreshToken);
    const user = await usersRepository.findById(rotated.userId);
    if (!user) {
      throw new UnauthorizedError('Session is invalid or has been revoked');
    }

    const accessToken = signAccessToken({
      sub: user.id,
      email: user.email,
      sid: rotated.sessionId,
    });

    return { accessToken, refreshToken: rotated.refreshToken, sessionId: rotated.sessionId };
  },

  async logout(sessionId: string): Promise<void> {
    await sessionService.revoke(sessionId);
  },

  async logoutAll(userId: string): Promise<void> {
    await sessionService.revokeAllForUser(userId);
  },

  async requestPasswordReset(rawEmail: string): Promise<void> {
    const user = await usersRepository.findByEmail(normalizeEmail(rawEmail));
    if (!user) {
      // Do not leak whether the email is registered.
      return;
    }

    const token = await oneTimeToken.issue('pwreset', user.id, PASSWORD_RESET_TTL_SECONDS);

    await emailService.enqueue({
      to: user.email,
      subject: 'Reset your password',
      template: 'password-reset',
      data: {
        name: user.name ?? user.email,
        resetUrl: `${env.FRONTEND_URL}/reset-password?token=${token}`,
        expiresInMinutes: PASSWORD_RESET_TTL_SECONDS / 60,
      },
    });
  },

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await oneTimeToken.consume('pwreset', token);
    if (!userId) {
      throw new UnauthorizedError('Invalid or expired password reset token');
    }

    const passwordHash = await hashPassword(newPassword);
    await usersRepository.updatePassword(userId, passwordHash);
    // Anyone holding a stolen session is kicked out by the password change,
    // which is the whole point of resetting it.
    await sessionService.revokeAllForUser(userId);
  },
};
