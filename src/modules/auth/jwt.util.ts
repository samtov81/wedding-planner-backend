import jwt from 'jsonwebtoken';

import { env } from '../../config/env';
import { UnauthorizedError } from '../../common/errors/app-error';

export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  email: string;
  /** Session id, so revoking a session also invalidates its access tokens. */
  sid: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    // Pinning `algorithms` is what blocks the classic algorithm-confusion
    // attack (a token forged with alg:none or a swapped algorithm).
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as jwt.JwtPayload;

    if (!decoded.sub || typeof decoded.email !== 'string' || typeof decoded.sid !== 'string') {
      throw new Error('Malformed access token payload');
    }

    return { sub: decoded.sub, email: decoded.email, sid: decoded.sid };
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }
}
