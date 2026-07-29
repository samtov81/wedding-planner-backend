import { Router } from 'express';

import { asyncHandler } from '../../common/http/async-handler';
import { requireAuth } from '../auth/auth.middleware';
import { usersController } from './users.controller';

export const usersRouter = Router();

usersRouter.get('/me', requireAuth, asyncHandler(usersController.me));
