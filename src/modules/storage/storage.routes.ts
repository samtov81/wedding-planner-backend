import { Router } from 'express';

import { asyncHandler } from '../../common/http/async-handler';
import { requireAuth } from '../auth/auth.middleware';
import { storageController } from './storage.controller';

export const storageRouter = Router();

storageRouter.get('/upload-url', requireAuth, asyncHandler(storageController.getUploadUrl));
storageRouter.get('/download-url', requireAuth, asyncHandler(storageController.getDownloadUrl));
