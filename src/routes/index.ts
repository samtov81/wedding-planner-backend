import { Router } from 'express';

import { authRouter } from '../modules/auth/auth.routes';
import { notificationsRouter } from '../modules/notifications/notifications.routes';
import { storageRouter } from '../modules/storage/storage.routes';
import { usersRouter } from '../modules/users/users.routes';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/storage', storageRouter);
apiRouter.use('/notifications', notificationsRouter);
