import type { NextFunction, Request, Response } from 'express';

import { UnauthorizedError } from '../../common/errors/app-error';
import { verifyAccessToken } from './jwt.util';
import { sessionService } from './session.service';

function readAccessToken(req: Request): string | undefined {
  return req.cookies?.access_token as string | undefined;
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = readAccessToken(req);
    if (!token) {
      throw new UnauthorizedError('Authentication required');
    }

    const payload = verifyAccessToken(token);

    // A valid signature is not enough: the session behind it may have been
    // revoked (logout, password reset, refresh-token reuse) seconds ago.
    if (!(await sessionService.isActive(payload.sid))) {
      throw new UnauthorizedError('Session is invalid or has been revoked');
    }

    req.user = { id: payload.sub, email: payload.email, sessionId: payload.sid };
    next();
  } catch (err) {
    next(err);
  }
}

export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = readAccessToken(req);

  if (token) {
    try {
      const payload = verifyAccessToken(token);
      if (await sessionService.isActive(payload.sid)) {
        req.user = { id: payload.sub, email: payload.email, sessionId: payload.sid };
      }
    } catch {
      // ignore invalid token for optional auth
    }
  }

  next();
}
