import type { Socket } from 'socket.io';

import { verifyAccessToken } from '../auth/jwt.util';
import { sessionService } from '../auth/session.service';

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): Promise<void> {
  const tokenFromAuth = socket.handshake.auth?.token as string | undefined;
  const tokenFromCookie = parseCookieHeader(socket.handshake.headers.cookie).access_token;
  const token = tokenFromAuth ?? tokenFromCookie;

  if (!token) {
    next(new Error('Authentication required'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    // Same revocation check as HTTP requests: a socket must not outlive the
    // session that opened it.
    if (!(await sessionService.isActive(payload.sid))) {
      next(new Error('Session is invalid or has been revoked'));
      return;
    }
    socket.data.user = { id: payload.sub, email: payload.email, sessionId: payload.sid };
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}
