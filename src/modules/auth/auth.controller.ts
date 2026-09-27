import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';

import { UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import { noContent, ok } from '../../common/http/response';
import { parseDurationToMs } from '../../common/http/duration';
import { env } from '../../config/env';
import { clearCsrfCookie, issueCsrfCookie } from '../../middleware/csrf.middleware';
import { authService, type AuthTokens } from './auth.service';
import { passwordIsDerivedFromEmail, passwordSchema } from './password-policy';

// Scoped to the auth routes so the long-lived refresh token is not attached to
// every API call. Must match the mount point in src/routes/index.ts.
const REFRESH_COOKIE_PATH = '/api/auth';

const emailSchema = z.string().email().max(254);

const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    name: z.string().min(1).max(120).optional(),
  })
  .refine((value) => !passwordIsDerivedFromEmail(value.password, value.email), {
    message: 'Password must not contain your email address',
    path: ['password'],
  });

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

const emailOnlySchema = z.object({ email: emailSchema });

const tokenSchema = z.object({ token: z.string().min(1).max(512) });

const confirmResetSchema = z.object({
  token: z.string().min(1).max(512),
  password: passwordSchema,
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('Invalid request body', result.error.flatten().fieldErrors);
  }
  return result.data;
}

function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    // Omitted entirely when unset: a host-only cookie is not shared with
    // sibling subdomains.
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/**
 * `rotateCsrf` is on for login (a fresh browser session gets a fresh token,
 * which kills any pre-seeded one) and off for refresh, so a token rotation
 * happening in the background never invalidates the header the page is
 * already using.
 */
function setAuthCookies(res: Response, tokens: AuthTokens, rotateCsrf: boolean): void {
  res.cookie('access_token', tokens.accessToken, {
    ...baseCookieOptions(),
    path: '/',
    maxAge: parseDurationToMs(env.JWT_ACCESS_TTL),
  });

  res.cookie('refresh_token', `${tokens.sessionId}.${tokens.refreshToken}`, {
    ...baseCookieOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });

  if (rotateCsrf) {
    issueCsrfCookie(res);
  }
}

function clearAuthCookies(res: Response): void {
  const scope = env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {};

  res.clearCookie('access_token', { ...scope, path: '/' });
  res.clearCookie('refresh_token', { ...scope, path: REFRESH_COOKIE_PATH });
  clearCsrfCookie(res);
}

function parseRefreshCookie(req: Request): { sessionId: string; refreshToken: string } {
  const raw = req.cookies?.refresh_token as string | undefined;
  const [sessionId, refreshToken] = raw?.split('.') ?? [];
  if (!sessionId || !refreshToken) {
    throw new UnauthorizedError('Missing refresh token');
  }
  return { sessionId, refreshToken };
}

export const authController = {
  /** Hands the client a CSRF token before its first state-changing request. */
  csrf(_req: Request, res: Response) {
    const token = issueCsrfCookie(res);
    return ok(res, { csrfToken: token });
  },

  async register(req: Request, res: Response) {
    const input = parseBody(registerSchema, req.body);
    await authService.register(input.email, input.password, input.name);
    // 202 with a fixed message for every outcome: whether the address was
    // already registered is only ever revealed inside the email.
    return ok(
      res,
      { message: 'If the address is available, a confirmation email has been sent.' },
      202,
    );
  },

  async verifyEmail(req: Request, res: Response) {
    const input = parseBody(tokenSchema, req.body);
    await authService.verifyEmail(input.token);
    return ok(res, { success: true });
  },

  async resendVerification(req: Request, res: Response) {
    const input = parseBody(emailOnlySchema, req.body);
    await authService.resendVerification(input.email);
    return ok(res, { message: 'If the account needs verification, an email has been sent.' });
  },

  async login(req: Request, res: Response) {
    const input = parseBody(loginSchema, req.body);
    const tokens = await authService.login(input.email, input.password, {
      userAgent: req.get('user-agent') ?? undefined,
      ipAddress: req.ip,
    });
    setAuthCookies(res, tokens, true);
    return ok(res, { success: true });
  },

  async refresh(req: Request, res: Response) {
    const { sessionId, refreshToken } = parseRefreshCookie(req);
    const tokens = await authService.refresh(sessionId, refreshToken);
    setAuthCookies(res, tokens, false);
    return ok(res, { success: true });
  },

  async logout(req: Request, res: Response) {
    const raw = req.cookies?.refresh_token as string | undefined;
    const [sessionId] = raw?.split('.') ?? [];
    if (sessionId) {
      await authService.logout(sessionId);
    }
    clearAuthCookies(res);
    return noContent(res);
  },

  async logoutAll(req: Request, res: Response) {
    await authService.logoutAll(req.user!.id);
    clearAuthCookies(res);
    return noContent(res);
  },

  async requestPasswordReset(req: Request, res: Response) {
    const input = parseBody(emailOnlySchema, req.body);
    await authService.requestPasswordReset(input.email);
    return ok(res, { message: 'If the account exists, a reset email has been sent.' });
  },

  async confirmPasswordReset(req: Request, res: Response) {
    const input = parseBody(confirmResetSchema, req.body);
    await authService.resetPassword(input.token, input.password);
    return ok(res, { success: true });
  },
};
