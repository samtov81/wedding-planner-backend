import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import pinoHttp from 'pino-http';

import { logger } from './config/logger';
import { csrfProtection } from './middleware/csrf.middleware';
import { errorHandler, notFoundHandler } from './middleware/error-handler.middleware';
import { applySecurityMiddleware } from './middleware/security.middleware';
import { apiRouter } from './routes';

export function createApp(): Express {
  const app = express();

  applySecurityMiddleware(app);
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Runs after cookieParser and before any route: every state-changing request
  // under /api must echo the CSRF cookie in the X-CSRF-Token header.
  app.use('/api', csrfProtection, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
