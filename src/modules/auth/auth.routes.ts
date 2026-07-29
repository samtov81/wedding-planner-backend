import { Router } from 'express';

import { asyncHandler } from '../../common/http/async-handler';
import { createRateLimiter } from '../../middleware/rate-limit.middleware';
import { authController } from './auth.controller';
import { requireAuth } from './auth.middleware';

// Per-IP ceiling. The per-account brute-force protection lives in
// login-throttle.service.ts, since an IP limiter alone never sees a
// distributed attack against a single account.
const authRateLimiter = createRateLimiter({
  keyPrefix: 'rl:auth',
  points: 20,
  durationSeconds: 60,
});

// Endpoints that send an email: much tighter, they cost money and can be used
// to spam a third party's inbox.
const emailRateLimiter = createRateLimiter({
  keyPrefix: 'rl:auth:email',
  points: 5,
  durationSeconds: 60 * 60,
});

export const authRouter = Router();

authRouter.get('/csrf', authController.csrf);

authRouter.post('/register', emailRateLimiter, asyncHandler(authController.register));
authRouter.post('/login', authRateLimiter, asyncHandler(authController.login));
authRouter.post('/refresh', authRateLimiter, asyncHandler(authController.refresh));
authRouter.post('/logout', asyncHandler(authController.logout));
authRouter.post('/logout-all', requireAuth, asyncHandler(authController.logoutAll));

authRouter.post(
  '/verify-email/request',
  emailRateLimiter,
  asyncHandler(authController.resendVerification),
);
authRouter.post(
  '/verify-email/confirm',
  authRateLimiter,
  asyncHandler(authController.verifyEmail),
);
authRouter.post(
  '/password-reset/request',
  emailRateLimiter,
  asyncHandler(authController.requestPasswordReset),
);
authRouter.post(
  '/password-reset/confirm',
  authRateLimiter,
  asyncHandler(authController.confirmPasswordReset),
);
