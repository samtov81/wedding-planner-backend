import { Router } from 'express';

import { asyncHandler } from '../../common/http/async-handler';
import { requireAuth } from '../auth/auth.middleware';
import { notificationsController } from './notifications.controller';

export const notificationsRouter = Router();

notificationsRouter.post(
  '/devices',
  requireAuth,
  asyncHandler(notificationsController.registerDevice),
);
notificationsRouter.delete(
  '/devices',
  requireAuth,
  asyncHandler(notificationsController.unregisterDevice),
);
