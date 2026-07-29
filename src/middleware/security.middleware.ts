import cors from 'cors';
import type { Express } from 'express';
import helmet from 'helmet';

import { env, isProduction } from '../config/env';

export function applySecurityMiddleware(app: Express): void {
  app.disable('x-powered-by');
  // Only trust as many proxy hops as actually exist, otherwise a client can
  // forge X-Forwarded-For and dodge the IP rate limiter.
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      // HSTS on a plain-http dev host would pin the browser to https for months.
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      maxAge: 600,
    }),
  );
}
