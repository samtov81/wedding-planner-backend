import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { CsrfError } from '../common/errors/app-error';
import { env } from '../config/env';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit cookie. Auth lives in httpOnly cookies, so the browser attaches
 * it to cross-site requests automatically; SameSite=Strict already blocks most
 * of that, and this is the defence-in-depth layer for the cases it doesn't
 * cover (older browsers, a compromised sibling subdomain). The cookie is
 * readable by JS on purpose - a cross-origin attacker still cannot read it and
 * therefore cannot echo it back in the header.
 */
export function issueCsrfCookie(res: Response): string {
  const token = crypto.randomBytes(32).toString('base64url');

  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'strict',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    path: '/',
    maxAge: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });

  return token;
}

export function clearCsrfCookie(res: Response): void {
  res.clearCookie(CSRF_COOKIE, {
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    path: '/',
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const headerToken = req.get(CSRF_HEADER);

  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    next(new CsrfError());
    return;
  }

  next();
}
